import type {
  ClaimCheckResult,
  ClaimCheckRule,
  ClaimCheckViolation,
  FactLedger,
  FactLedgerClaim,
  SummarizedArticle
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
const GENERIC_COMMENT = /注目|期待|目が離せない/;
const BANNED_PHRASE_OTHER = /活性化|が加速/;

export function runClaimCheck(summary: SummarizedArticle, ledger: FactLedger): ClaimCheckResult {
  const violations: ClaimCheckViolation[] = [];
  const ledgerNumbers = new Set(
    ledger.claims.flatMap((claim) => claim.numbers).flatMap((value) => extractNumberTokens(value).map(normalizeNumberToken))
  );
  const ledgerEntities = ledger.claims.flatMap((claim) => claim.entities).filter(Boolean);

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
        if (normalized && ![...ledgerNumbers].some((ledgerNumber) => ledgerNumber.includes(normalized) || normalized.includes(ledgerNumber))) {
          violations.push(toViolation(section, "number_not_in_ledger", "warning", detail));
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

      if (section !== "japan_context_note" && detail.includes("日本") && !referencedClaims(summary, section, ledger).some(isJapanRelatedClaim)) {
        violations.push(toViolation(section, "japan_comparison_no_claim", "warning", detail));
      }

      if (UNATTRIBUTED_ANALYSIS.test(detail)) {
        const sourceAnalysisClaims = referencedClaims(summary, section, ledger).filter((claim) => claim.type === "source_analysis");
        if (!sourceAnalysisClaims.length || !sourceAnalysisClaims.some((claim) => claim.source_name && detail.includes(claim.source_name))) {
          violations.push(toViolation(section, "unattributed_analysis", "warning", detail));
        }
      }

      if (section === "editor_comment" && detail.length < 40 && GENERIC_COMMENT.test(detail)) {
        violations.push(toViolation(section, "generic_comment", "warning", detail));
      }

      if (BANNED_PHRASE_OTHER.test(detail)) {
        violations.push(toViolation(section, "banned_phrase_other", "warning", detail));
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
  return value
    .replace(/[０-９]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "")
    .replace(/億元|亿元|億|亿/g, "亿")
    .replace(/％/g, "%")
    .trim();
}

function splitSentences(value: string) {
  return value.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
}

function extractNumberTokens(value: string) {
  return value.match(/[0-9０-９]+(?:[.,，．][0-9０-９]+)?(?:億円|亿元|億|亿|万人|万|円|元|%|％|年|月|日|本|件|回|歳|カ国|か国)?/g) ?? [];
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
