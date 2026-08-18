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
import { isEditorialInsightClaim } from "./editorialInsight.js";
import { inspectLiteralTranslationResidues, inspectLiteralTranslationText } from "./translationQuality.js";

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
const COMMENT_BACKGROUND_PATTERN = /とは、|という(仕組み|制度|賞|文化|呼び方|システム)|で決ま(る|り)|が決め|と呼ばれ/;

export const BACKGROUND_GROUNDING_THRESHOLD = 0.35;

export function runClaimCheck(summary: SummarizedArticle, ledger: FactLedger): ClaimCheckResult {
  const violations: ClaimCheckViolation[] = [];
  const evidenceRoles = ledger.evidence_roles ?? {};
  const evidenceQuality = ledger.evidence_quality ?? [];
  if (evidenceQuality.length) {
    const rootQuality = evidenceQuality.filter((item) => evidenceRoles[item.evidence_ref] !== "related_angle");
    if (rootQuality.length && !rootQuality.some((item) => item.usable_for_verified_facts)) {
      violations.push(toViolation("fact_ledger", "evidence_quality_insufficient", "gate", rootQuality.map((item) => `${item.evidence_ref}:${item.reason}`).join(", ")));
    }
    const qualityByRef = new Map(evidenceQuality.map((item) => [item.evidence_ref, item]));
    for (const claim of ledger.claims.filter((item) => item.type === "verified_fact")) {
      const qualities = claim.evidence_refs.map((ref) => qualityByRef.get(ref)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (qualities.length && !qualities.some((item) => item.usable_for_verified_facts)) {
        violations.push(toViolation("fact_ledger", "verified_claim_low_trust", "gate", `${claim.id}: ${claim.evidence_refs.join(", ")}`));
      }
    }
  }
  if (Object.keys(evidenceRoles).length) {
    for (const claim of ledger.claims.filter((item) => item.type !== "unsupported")) {
      const roles = claim.evidence_refs.map((ref) => evidenceRoles[ref]);
      if (roles.some((role) => !role)) {
        violations.push(toViolation("fact_ledger", "claim_evidence_ref_unknown", "gate", `${claim.id}: ${claim.evidence_refs.join(", ")}`));
        continue;
      }
      if (claim.scope === "related_angle") {
        if (!roles.length || roles.some((role) => role !== "related_angle")) {
          violations.push(toViolation("fact_ledger", "related_claim_missing_related_evidence", "gate", `${claim.id}: ${claim.evidence_refs.join(", ")}`));
        }
      } else if (!roles.length || roles.some((role) => role !== "root_corroboration")) {
        violations.push(toViolation("fact_ledger", "root_claim_uses_related_evidence", "gate", `${claim.id}: ${claim.evidence_refs.join(", ")}`));
      }
    }
  }
  const ledgerNumbers = new Set(
    ledger.claims.flatMap((claim) => [
      ...claim.numbers,
      claim.text,
      ...claim.entities,
      claim.quote_zh || ""
    ]).flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken)).filter(Boolean)
  );
  const ledgerEntities = ledger.claims.flatMap((claim) => [...claim.entities, claim.text]).filter(Boolean);
  const japanContextNote = summary.japan_context_note ?? "";
  const detailSections = summary.detail_sections ?? [];
  const validClaimIds = new Set(ledger.claims.map((claim) => claim.id));
  for (const [index, detailSection] of detailSections.entries()) {
    if (detailSection.body.trim() && detailSection.claim_refs.length === 0) {
      violations.push(toViolation(`detail_sections.${index}`, "claim_evidence_ref_unknown", "gate", "detail section has no claim refs"));
    }
    const unknownRefs = detailSection.claim_refs.filter((id) => !validClaimIds.has(id));
    if (unknownRefs.length) {
      violations.push(toViolation(`detail_sections.${index}`, "claim_evidence_ref_unknown", "gate", unknownRefs.join(", ")));
    }
  }
  for (const residue of inspectLiteralTranslationResidues(summary)) {
    violations.push(toViolation(residue.field, "literal_translation_residue", "gate", `${residue.term}: ${residue.guidance}`));
  }

  if (
    japanContextNote.trim()
    && referencedClaims(summary, "japan_context_note", ledger).length === 0
  ) {
    violations.push(toViolation(
      "japan_context_note",
      "japan_context_note_without_claim_ref",
      "gate",
      japanContextNote.trim()
    ));
  }

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
  for (const [index, detailSection] of detailSections.entries()) {
    checkGroundedText(detailSection.body, `detail_sections.${index}`, detailSection.claim_refs, ledger, ledgerNumbers, ledgerEntities, violations);
  }

  return {
    topic_key: ledger.topic_key,
    violations,
    gated_violation_count: violations.filter((violation) => violation.severity === "gate").length,
    action: "none"
  };
}

function checkGroundedText(
  text: string,
  section: string,
  claimRefs: string[],
  ledger: FactLedger,
  ledgerNumbers: Set<string>,
  ledgerEntities: string[],
  violations: ClaimCheckViolation[]
) {
  const claims = ledger.claims.filter((claim) => claimRefs.includes(claim.id));
  const referencedNumbers = new Set(
    claims.flatMap((claim) => [...claim.numbers, claim.text, claim.quote_zh || ""])
      .flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken))
      .filter(Boolean)
  );
  for (const sentence of splitSentences(text)) {
    const detail = sentence.trim();
    if (!detail) continue;
    for (const token of extractNumberTokens(detail)) {
      const normalized = normalizeNumberToken(token);
      if (normalized && (!ledgerNumbers.has(normalized) || !referencedNumbers.has(normalized))) {
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
    if (/日本(の|と|でも|より|では)/.test(detail) && !claims.some(isJapanRelatedClaim)) {
      violations.push(toViolation(section, "japan_comparison_no_claim", "warning", detail));
    }
  }
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
    if (
      section === "japan_context_note"
      && sectionViolations.some((violation) => violation.rule === "japan_context_note_without_claim_ref")
    ) {
      next.japan_context_note = "";
      next.claim_refs = { ...summary.claim_refs, japan_context_note: [] };
      continue;
    }
    next[section] = splitSentences(summary[section])
      .filter((sentence) => !sectionViolations.some((violation) => sentence.includes(violation.detail) || violation.detail.includes(sentence.trim())))
      .join("")
      .trim();
    if (section === "japan_context_note" && !next.japan_context_note) {
      next.claim_refs = { ...summary.claim_refs, japan_context_note: [] };
    }
  }
  next.detail_sections = (summary.detail_sections ?? []).map((section, index) => ({
    ...section,
    body: splitSentences(section.body)
      .filter((sentence) => !gated.some((violation) => violation.section === `detail_sections.${index}` && (sentence.includes(violation.detail) || violation.detail.includes(sentence.trim()))))
      .join("")
      .trim()
  })).filter((section) => section.body);
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
  toneMode: ToneMode,
  context: { usedOpenings?: string[]; bodyText?: string; commentClaimRefs?: string[]; bodyClaimRefs?: string[] } = {}
): ClaimCheckViolation[] {
  const text = whyItMatters;
  const violations: ClaimCheckViolation[] = [];
  for (const residue of inspectLiteralTranslationText(text, "comment")) {
    violations.push(toViolation("comment", "literal_translation_residue", "gate", `${residue.term}: ${residue.guidance}`));
  }
  const validClaimIds = new Set(ledger.claims.map((claim) => claim.id));
  const commentClaimRefs = [...new Set((context.commentClaimRefs ?? []).filter((ref) => validClaimIds.has(ref)))];
  const bodyClaimRefs = new Set(context.bodyClaimRefs ?? []);
  const commentClaims = ledger.claims.filter((claim) => commentClaimRefs.includes(claim.id));
  const availableInsightClaims = ledger.claims.filter((claim) =>
    claim.type !== "unsupported" && claim.anchor !== false && !bodyClaimRefs.has(claim.id) && isEditorialInsightClaim(claim)
  );
  if (text.trim() && commentClaimRefs.length === 0) {
    violations.push(toViolation("comment", "comment_claim_refs_missing", "gate", "注目ポイントにclaim refsがありません"));
  }
  if (
    toneMode === "normal"
    && text.trim()
    && commentClaimRefs.length > 0
    && commentClaimRefs.every((ref) => bodyClaimRefs.has(ref))
    && !commentClaims.some(isEditorialInsightClaim)
  ) {
    violations.push(toViolation("comment", "comment_no_new_editorial_claim", "gate", "本文で使用済みのclaimだけを言い換えています"));
  }
  if (toneMode === "normal" && availableInsightClaims.length > 0 && !availableInsightClaims.some((claim) => commentClaimRefs.includes(claim.id))) {
    violations.push(toViolation("comment", "comment_insight_claim_missing", "gate", `編集インサイト候補を参照していません: ${availableInsightClaims.map((claim) => claim.id).join(", ")}`));
  }
  const commentInsightRoles = new Set(commentClaims.filter(isEditorialInsightClaim).map((claim) => claim.editorial_role));
  const ledgerHasConcreteWorkMechanism = ledger.claims.some((claim) =>
    claim.type !== "unsupported"
    && (["story_premise", "comic_mechanism", "modern_life_bridge", "adaptation_context"] as const).some((role) => claim.editorial_role === role)
  );
  if (
    toneMode === "normal"
    && (topic.main_entities?.works?.length ?? 0) > 0
    && ledgerHasConcreteWorkMechanism
    && commentInsightRoles.size === 1
    && commentInsightRoles.has("genre_contrast")
  ) {
    violations.push(toViolation("comment", "comment_insight_claim_missing", "gate", "ジャンルの違いだけでなく、物語上の仕掛け・笑いの構造・現代感覚・映像化のいずれかを根拠claimで説明してください"));
  }
  if (
    toneMode === "normal"
    && /(?:予約|再生|閲覧|読者|フォロワー|数字)/u.test(text)
    && /(?:ここから|今後|次に|見たい|追いたい|気にな)/u.test(text)
    && !/(?:違い|なぜ|仕掛け|組み合わせ|逆手|笑い|面白|おもしろ|定番)/u.test(text)
    && commentClaims.length > 0
    && commentClaims.every((claim) => claim.editorial_role === "key_numbers" || claim.editorial_role === "audience_evidence" || claim.editorial_role === "other")
  ) {
    violations.push(toViolation("comment", "comment_number_watch_template", "gate", "数字と今後の観測だけで、作品固有の面白さを説明していません"));
  }
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
  const ledgerNumbers = new Set(
    ledger.claims.flatMap((claim) => [
      ...claim.numbers,
      claim.text,
      ...claim.entities,
      claim.quote_zh || ""
    ]).flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken)).filter(Boolean)
  );
  const referencedNumbers = new Set(
    commentClaims.flatMap((claim) => [...claim.numbers, claim.text, claim.quote_zh || ""])
      .flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken)).filter(Boolean)
  );
  const ledgerEntities = ledger.claims.flatMap((claim) => [...claim.entities, claim.text]).filter(Boolean);
  const referencedEntities = commentClaims.flatMap((claim) => [...claim.entities, claim.text]).filter(Boolean);
  const groundedBackground = [
    ...ledger.claims.map((claim) => claim.text),
    ...ledger.terms
      .filter((term) => Boolean(term.explain_quote_zh))
      .flatMap((term) => [term.gloss_ja, term.what_is || "", term.why_now || ""]),
    context.bodyText || ""
  ].filter(Boolean).join("\n");

  for (const sentence of splitSentences(whyItMatters)) {
    const detail = sentence.trim();
    if (!detail) continue;
    for (const token of extractNumberTokens(detail)) {
      const normalized = normalizeNumberToken(token);
      if (normalized && (!ledgerNumbers.has(normalized) || (commentClaims.length > 0 && !referencedNumbers.has(normalized)))) {
        violations.push(toViolation("comment", "comment_number_not_in_ledger", "gate", detail));
        break;
      }
    }
    for (const entity of extractBracketedEntities(detail)) {
      if (
        !ledgerEntities.some((ledgerEntity) => ledgerEntity.includes(entity) || entity.includes(ledgerEntity))
        || (commentClaims.length > 0 && !referencedEntities.some((ledgerEntity) => ledgerEntity.includes(entity) || entity.includes(ledgerEntity)))
      ) {
        violations.push(toViolation("comment", "comment_entity_not_in_ledger", "warning", detail));
        break;
      }
    }
    if (
      COMMENT_BACKGROUND_PATTERN.test(detail)
      && shingleContainment(detail, groundedBackground) < BACKGROUND_GROUNDING_THRESHOLD
    ) {
      violations.push(toViolation("comment", "comment_ungrounded_background", "gate", detail));
    }
  }
  for (const sentence of splitSentences(text).filter((item) => /かも|みたい|のようです/.test(item))) {
    const hasLedgerNumber = extractNumberTokens(sentence).map(normalizeNumberToken).some((token) => ledgerNumbers.has(token));
    const hasLedgerEntity = ledgerEntities.some((entity) => entity && sentence.includes(entity));
    if (hasLedgerNumber || hasLedgerEntity) {
      violations.push(toViolation("comment", "hedged_verified_fact", "warning", sentence.trim()));
    }
  }
  const opening = getCommentOpening(whyItMatters);
  if (opening && (context.usedOpenings ?? []).includes(opening)) {
    violations.push(toViolation("comment", "comment_opening_duplicate", "warning", opening));
  }
  if (context.bodyText && isCommentParaphrase(whyItMatters, context.bodyText)) {
    violations.push(toViolation("comment", "comment_paraphrase", "warning", "注目ポイントが本文の言い換えになっています"));
  }
  return violations;
}

export function getCommentOpening(value: string) {
  return value.replace(/[\s「」『』“”]/g, "").slice(0, 10);
}

export function isCommentParaphrase(whyItMatters: string, bodyText: string) {
  const sentences = splitSentences(whyItMatters).map((sentence) => sentence.replace(/[。！？!?]/g, "").trim()).filter((sentence) => sentence.length >= 15);
  if (!sentences.length) return false;
  const paraphrases = sentences.map((sentence) => shingleContainment(sentence, bodyText) >= 0.55);
  return paraphrases[0] || paraphrases.filter(Boolean).length / paraphrases.length >= 0.5;
}

export function shingleContainment(value: string, bodyText: string) {
  const normalized = value.replace(/\s+/g, "");
  const body = bodyText.replace(/\s+/g, "");
  const shingles = new Set<string>();
  for (let index = 0; index <= normalized.length - 4; index += 1) shingles.add(normalized.slice(index, index + 4));
  if (!shingles.size) return 0;
  return [...shingles].filter((shingle) => body.includes(shingle)).length / shingles.size;
}

export function sanitizeExclamations(text: string, toneMode: ToneMode) {
  if (toneMode === "sober") return text.replace(/[！!]/g, "。").replace(/。。+/g, "。");
  let total = 0;
  const sanitized = splitSentences(text).map((sentence) => {
    let inSentence = 0;
    return sentence.replace(/[！!]/g, () => {
      total += 1;
      inSentence += 1;
      return total > 4 || inSentence > 1 ? "。" : "！";
    });
  }).join("").replace(/。。+/g, "。");
  if (total > 0 || !sanitized.trim()) return sanitized;

  // Normal comments must not silently pass with sober-looking punctuation.
  // This changes punctuation only, so no new fact or editorial angle is added.
  const sentences = splitSentences(sanitized);
  const reactionPattern = /面白|おもしろ|気にな|楽し|驚|すご|見たい|追いたい|大事|注目ポイント|期待/;
  const reactionIndex = sentences.findIndex((sentence) => reactionPattern.test(sentence));
  const target = reactionIndex >= 0 ? reactionIndex : 0;
  sentences[target] = sentences[target].replace(/[。？?]?$/u, "！");
  return sentences.join("");
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
  return [
    ...value.matchAll(/《([^》]+)》/g),
    ...value.matchAll(/『([^』]+)』/g)
  ].map((match) => match[1].trim()).filter(Boolean);
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
