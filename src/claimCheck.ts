import type {
  ClaimCheckResult,
  ClaimCheckRule,
  ClaimCheckViolation,
  FactLedger,
  FactLedgerClaim,
  SummarizedArticle,
  ToneMode,
  TopicCandidate
} from "./types.js";

const SECTION_NAMES = [
  "lead",
  "what_happened",
  "why_it_matters",
  "reaction_view",
  "japan_context_note",
  "editor_comment"
] as const;

type CheckedSection = (typeof SECTION_NAMES)[number];

const JAPAN_NEGATIVE_ASSERTION = /日本では?未公開|日本未公開|日本未上陸|日本では(まだ)?(公開|配信|上映)されていない/;
const JAPAN_POSITIVE_ASSERTION = /日本で(?:の)?(?:公開|配信|上映)(?:中|されている|が決定)|日本で(?:の)?(?:公開|配信|上映)が?決定/;
const PREDICTIVE_ASSERTION = /大ヒット確実|ヒット確実|成功確実|確実視|間違いない|必至/;
const UNSUPPORTED_GENERALIZATION = /これまで.{0,12}(なかった|存在しなかった)|統一基準がなかった|業界初|史上初|中国では一般的/;
const UNATTRIBUTED_ANALYSIS = /が鮮明|とみられる|とされる/;
const BANNED_PHRASE_OTHER = /活性化|が加速/;
const TERMINOLOGY_AVOID = /国家ラジオテレビ総局|国家ラジオ・テレビ総局|国家放送テレビ総局|国家広播電視総局|国家映画局/;

export function runClaimCheck(summary: SummarizedArticle, ledger: FactLedger): ClaimCheckResult {
  const violations: ClaimCheckViolation[] = [];
  const ledgerNumbers = new Set(
    ledger.claims.flatMap((claim) => [
      ...claim.numbers,
      claim.text,
      ...claim.entities,
      claim.quote_zh || ""
    ]).flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken)).filter(Boolean)
  );
  const ledgerEntities = ledger.claims.flatMap((claim) => [...claim.entities, claim.text]).filter(Boolean);

  for (const section of SECTION_NAMES) {
    const text = summary[section];
    if (!text) continue;
    for (const sentence of splitSentences(text)) {
      const detail = sentence.trim();
      if (!detail) continue;

      if (JAPAN_NEGATIVE_ASSERTION.test(detail) || (JAPAN_POSITIVE_ASSERTION.test(detail) && ledger.japan_availability.status !== "verified")) {
        violations.push(toViolation(section, "japan_availability_unverified", "gate", detail));
      }
      if (PREDICTIVE_ASSERTION.test(detail)) {
        violations.push(toViolation(section, "predictive_assertion_certain", "gate", detail));
      }

      const sentenceNumberTokens = extractNumberTokens(detail);
      for (const token of sentenceNumberTokens) {
        const normalized = normalizeNumberToken(token);
        if (normalized && !ledgerNumbers.has(normalized)) {
          violations.push(toViolation(section, "number_not_in_ledger", isHighRiskNumber(normalized) ? "gate" : "warning", detail));
          break;
        }
      }

      for (const entity of extractBracketedEntities(detail)) {
        if (!ledgerEntities.some((ledgerEntity) => ledgerEntity.includes(entity) || entity.includes(ledgerEntity))) {
          violations.push(toViolation(section, "entity_not_in_ledger", "warning", detail));
          break;
        }
      }

      if (UNSUPPORTED_GENERALIZATION.test(detail) && !hasMatchingClaim(detail, ledger.claims)) {
        violations.push(toViolation(section, "unsupported_generalization", "warning", detail));
      }

      if (section !== "japan_context_note" && /日本(の|と|でも|より|では)/.test(detail) && !detail.includes("日本語圏") && !referencedClaims(summary, section, ledger).some(isJapanRelatedClaim)) {
        violations.push(toViolation(section, "japan_comparison_no_claim", "warning", detail));
      }

      if (UNATTRIBUTED_ANALYSIS.test(detail)) {
        const sourceAnalysisClaims = referencedClaims(summary, section, ledger).filter((claim) => claim.type === "source_analysis");
        if (!sourceAnalysisClaims.length || !sourceAnalysisClaims.some((claim) => claim.source_name && detail.includes(claim.source_name))) {
          violations.push(toViolation(section, "unattributed_analysis", "warning", detail));
        }
      }

      if (BANNED_PHRASE_OTHER.test(detail)) {
        violations.push(toViolation(section, "banned_phrase_other", "warning", detail));
      }
      if (TERMINOLOGY_AVOID.test(detail)) {
        violations.push(toViolation(section, "terminology_avoid", "warning", detail));
      }
    }
  }

  return {
    topic_key: ledger.topic_key,
    violations,
    gated_violation_count: violations.filter((violation) => violation.severity === "gate").length,
    action: "none"
  };
}

export function removeGatedViolationSentences(
  summary: SummarizedArticle,
  violations: ClaimCheckViolation[]
): SummarizedArticle {
  const gated = violations.filter((violation) => violation.severity === "gate");
  if (!gated.length) return summary;
  const next = { ...summary };
  for (const section of SECTION_NAMES) {
    const sectionViolations = gated.filter((violation) => violation.section === section);
    if (!sectionViolations.length) continue;
    next[section] = splitSentences(summary[section])
      .filter((sentence) => !sectionViolations.some((violation) => sentence.includes(violation.detail) || violation.detail.includes(sentence.trim())))
      .join("")
      .trim();
  }
  return next;
}

export class ClaimCheckDiscardError extends Error {
  constructor(public readonly violations: ClaimCheckViolation[]) {
    super(`claim_check_gate: ${violations.map((violation) => `${violation.rule}:${violation.detail}`).join(" | ")}`);
    this.name = "ClaimCheckDiscardError";
  }
}

export function normalizeNumberToken(value: string) {
  let normalized = value
    .replace(/[０-９]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "")
    .replace(/．/g, ".")
    .replace(/萬/g, "万")
    .replace(/億/g, "亿")
    .replace(/％/g, "%")
    .trim();
  normalized = normalized.replace(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?/, (_, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`);
  normalized = normalized.replace(/[一二三四五六七八九十百千两]+/g, (token) => String(chineseNumber(token)));
  normalized = normalized.replace(/第(\d+)(?:届|回|期)/g, "第$1");
  normalized = normalized.replace(/(\d+(?:亿|万)?)(?:次|回|场|場)/g, "$1回");
  normalized = normalized.replace(/亿元/g, "亿元");
  return normalized;
}

export function runCommentCheck(
  whyItMatters: string,
  editorComment: string,
  ledger: FactLedger,
  topic: TopicCandidate,
  toneMode: ToneMode
): ClaimCheckViolation[] {
  const text = `${whyItMatters}\n${editorComment}`;
  const violations: ClaimCheckViolation[] = [];
  if (/反応が(予想|期待)され|好意的な反応|ファンから.{0,12}(反応|声)が(集ま|上が|出)/.test(text) && (topic.source_mix.sns || 0) + (topic.source_mix.rumor || 0) === 0) {
    violations.push(toViolation("comment", "fabricated_reaction", "gate", matchingSentence(text, /反応が(予想|期待)され|好意的な反応|ファンから.{0,12}(反応|声)が(集ま|上が|出)/)));
  }
  if (/ではないでしょうか/.test(text)) violations.push(toViolation("comment", "unverified_speculation", "gate", matchingSentence(text, /ではないでしょうか/)));
  if (/かもしれません/.test(text)) violations.push(toViolation("comment", "unverified_speculation", "warning", matchingSentence(text, /かもしれません/)));
  const template = /業界全体に影響を与える可能性|透明性向上につながる可能性|今後の動向(に|を)?(注目|注視|追|見守)|評価のポイントになりそう|新たな指標になるか|目が離せ(ない|ません)|今後注目したい|注目したいところ|注目が集ま(りそう|る)/;
  if (template.test(text)) violations.push(toViolation("comment", "template_comment", "gate", matchingSentence(text, template)));
  const exclamations = (text.match(/[！!]/g) || []).length;
  const tooManyInSentence = splitSentences(text).some((sentence) => (sentence.match(/[！!]/g) || []).length > 1);
  if (toneMode === "sober" && exclamations > 0) violations.push(toViolation("comment", "tone_exclamation", "gate", text));
  if (toneMode === "normal" && (exclamations === 0 || exclamations > 4 || tooManyInSentence)) violations.push(toViolation("comment", "tone_exclamation", "warning", text));
  splitSentences(text).filter((sentence) => sentence.replace(/[。！？!?]/g, "").length > 90).forEach((sentence) => violations.push(toViolation("comment", "long_sentence", "warning", sentence.trim())));
  const desuNeCount = splitSentences(text).filter((sentence) => /ですね[。！!]$/.test(sentence.trim())).length;
  if (desuNeCount >= 3) violations.push(toViolation("comment", "ending_repetition", "warning", `ですね文末: ${desuNeCount}回`));
  const ledgerNumbers = new Set(ledger.claims.flatMap((claim) => claim.numbers).flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken)).filter(Boolean));
  const ledgerEntities = ledger.claims.flatMap((claim) => claim.entities).filter(Boolean);
  for (const sentence of splitSentences(text).filter((item) => /かも|みたい|のようです/.test(item))) {
    const hasLedgerNumber = extractNumberTokens(sentence).map(normalizeNumberToken).some((token) => ledgerNumbers.has(token));
    const hasLedgerEntity = ledgerEntities.some((entity) => entity && sentence.includes(entity));
    if (hasLedgerNumber || hasLedgerEntity) {
      violations.push(toViolation("comment", "hedged_verified_fact", "warning", sentence.trim()));
    }
  }
  return violations;
}

export function sanitizeExclamations(text: string, toneMode: ToneMode) {
  if (toneMode === "sober") return text.replace(/[！!]/g, "。").replace(/。。+/g, "。");
  let total = 0;
  return splitSentences(text).map((sentence) => {
    let inSentence = 0;
    return sentence.replace(/[！!]/g, () => {
      total += 1;
      inSentence += 1;
      return total > 4 || inSentence > 1 ? "。" : "！";
    });
  }).join("").replace(/。。+/g, "。");
}

function splitSentences(value: string) {
  return value.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
}

export function extractNumberTokens(value: string) {
  const pattern = /[0-9０-９]{4}(?:-|年)[0-9０-９]{1,2}(?:-|月)[0-9０-９]{1,2}日?|第(?:[0-9０-９]+|[一二三四五六七八九十百千两]+)(?:届|回|期)|(?:[0-9０-９]+|[一二三四五六七八九十百千两]+)(?:[.,，．][0-9０-９]+)?(?:億|亿|万|萬)?(?:次|回|场|場)|(?:[0-9０-９]+|[一二三四五六七八九十百千两]+)(?:[.,，．][0-9０-９]+)?(?:億円|亿元|億|亿|万人|万|萬|円|元|%|％|年|月|日|本|件|歳|カ国|か国|人)?/g;
  return value.match(pattern) ?? [];
}

function chineseNumber(value: string) {
  if (value === "两") return 2;
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let result = 0;
  let current = 0;
  for (const char of value) {
    if (digits[char]) current = digits[char];
    else if (units[char]) {
      result += (current || 1) * units[char];
      current = 0;
    }
  }
  return Math.min(999, result + current);
}

function isHighRiskNumber(value: string) {
  return /(?:亿|万|元|%|人|回)/.test(value) || /\d{4}年\d{1,2}月\d{1,2}日/.test(value);
}

function matchingSentence(value: string, pattern: RegExp) {
  return splitSentences(value).find((sentence) => pattern.test(sentence))?.trim() || value.trim();
}

function extractBracketedEntities(value: string) {
  return [...value.matchAll(/《([^》]+)》/g)].map((match) => match[1].trim()).filter(Boolean);
}

function referencedClaims(summary: SummarizedArticle, section: CheckedSection, ledger: FactLedger) {
  const refs = section === "what_happened" || section === "why_it_matters" || section === "reaction_view" || section === "japan_context_note"
    ? summary.claim_refs[section]
    : [];
  return ledger.claims.filter((claim) => refs.includes(claim.id));
}

function isJapanRelatedClaim(claim: FactLedgerClaim) {
  return claim.text.includes("日本") || claim.entities.some((entity) => entity.includes("日本"));
}

function hasMatchingClaim(sentence: string, claims: FactLedgerClaim[]) {
  return claims.some((claim) => claim.type !== "unsupported" && (sentence.includes(claim.text) || claim.text.includes(sentence)));
}

function toViolation(section: string, rule: ClaimCheckRule, severity: "gate" | "warning", detail: string): ClaimCheckViolation {
  return { section, rule, severity, detail };
}
