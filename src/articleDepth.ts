import { normalizeNumberToken } from "./claimCheck.js";
import { convertDisplayText } from "./displayKanji.js";
import type { FactLedger, SummarizedArticle } from "./types.js";

export type ArticleDepthProfile = "standard" | "manual_evidence_rich";

export type ArticleDepthAssessment = NonNullable<import("./types.js").TopicGenerationMeta["article_depth"]>;

export function assessArticleDepth(
  summary: SummarizedArticle,
  ledger: FactLedger,
  profile: ArticleDepthProfile,
  regenerated = false
): ArticleDepthAssessment {
  const eligible = ledger.claims.filter((claim) =>
    claim.type !== "unsupported" && claim.scope !== "related_angle" && claim.anchor !== false
  );
  const validIds = new Set(eligible.map((claim) => claim.id));
  const sections = (summary.detail_sections ?? []).filter((section) => section.heading.trim() && section.body.trim());
  const referencedText = new Map<string, string[]>();
  // Core article depth is measured only by the factual body. Commentary,
  // reactions and Japan notes must not make a thin body look complete.
  addReferencedText(referencedText, summary.claim_refs.what_happened, summary.what_happened);
  const referencedIds = new Set([...referencedText.keys()].filter((id) => validIds.has(id)));
  const usedIds = new Set(eligible
    .filter((claim) => referencedIds.has(claim.id) && claimIsReflected(claim, (referencedText.get(claim.id) ?? []).join("\n")))
    .map((claim) => claim.id));
  const unrealizedIds = [...referencedIds].filter((id) => !usedIds.has(id));
  const numberClaims = eligible.filter((claim) => claim.numbers.length > 0);
  const usedNumberClaims = numberClaims.filter((claim) => usedIds.has(claim.id));
  const coverageRatio = eligible.length ? usedIds.size / eligible.length : 1;
  const reasons: string[] = [];

  if (profile === "manual_evidence_rich") {
    if (eligible.length < 3) reasons.push(`insufficient_eligible_claims:${eligible.length}<3`);
    const minimumUsedClaims = eligible.length >= 10
      ? Math.max(6, Math.ceil(eligible.length * 0.6))
      : eligible.length >= 6
        ? Math.ceil(eligible.length * 0.6)
        : Math.min(eligible.length, 3);
    const minimumNumberClaims = Math.ceil(numberClaims.length * 0.6);
    if (sections.length > 0) reasons.push(`unexpected_detail_sections:${sections.length}`);
    for (const id of unrealizedIds) reasons.push(`claim_ref_not_realized:${id}`);
    if (usedIds.size < minimumUsedClaims) reasons.push(`used_claims:${usedIds.size}<${minimumUsedClaims}`);
    if (usedNumberClaims.length < minimumNumberClaims) reasons.push(`used_number_claims:${usedNumberClaims.length}<${minimumNumberClaims}`);
    const minimumBodyLength = eligible.length >= 6 ? 220 : eligible.length >= 3 ? 150 : 0;
    if (minimumBodyLength && summary.what_happened.trim().length < minimumBodyLength) reasons.push(`what_happened_too_short:${summary.what_happened.trim().length}<${minimumBodyLength}`);
    const requiredRoles = new Set(eligible.map((claim) => claim.editorial_role).filter((role) => role && role !== "other"));
    for (const role of requiredRoles) {
      if (!eligible.some((claim) => claim.editorial_role === role && usedIds.has(claim.id))) reasons.push(`missing_editorial_role:${role}`);
    }
  }

  return {
    profile,
    eligible_claims: eligible.length,
    used_claims: usedIds.size,
    coverage_ratio: Number(coverageRatio.toFixed(3)),
    detail_sections: sections.length,
    important_number_claims: numberClaims.length,
    used_number_claims: usedNumberClaims.length,
    regenerated,
    passed: reasons.length === 0,
    reasons
  };
}

function addReferencedText(target: Map<string, string[]>, refs: string[], text: string) {
  for (const ref of refs) target.set(ref, [...(target.get(ref) ?? []), text]);
}

function claimIsReflected(claim: FactLedger["claims"][number], text: string) {
  const normalized = normalizeAnchor(text);
  const observedNumbers = new Set(extractDepthNumbers(text).map(normalizeDepthNumber));
  const numbers = claim.numbers.map(normalizeDepthNumber).filter(Boolean);
  if (numbers.length && !numbers.every((number) => observedNumbers.has(number))) return false;
  const entities = claim.entities.map(normalizeAnchor).filter((entity) => entity.length >= 2);
  if (entities.length && !entities.some((entity) => normalized.includes(entity))) return false;
  return true;
}

function normalizeDepthNumber(value: string) {
  return normalizeNumberToken(value)
    .replace(/亿元$/u, "亿")
    .replace(/万元$/u, "万")
    .replace(/館$/u, "馆");
}

function extractDepthNumbers(value: string) {
  return value.match(/(?:[0-9０-９]+|[一二三四五六七八九十百千两]+)(?:[.,，．][0-9０-９]+)?(?:億元|亿元|萬元|万元|億円|亿|億|万|萬|円|元|%|％|年|月|日|部|天|館|馆|面|本|件|人|回|場|场|歳)?/gu) ?? [];
}

function normalizeAnchor(value: string) {
  return convertDisplayText(value).toLowerCase().replace(/[\s,，。！？、；：,.!?;:（）()【】《》「」『』“”"']/gu, "");
}

export class ArticleDepthGateError extends Error {
  constructor(public readonly assessment: ArticleDepthAssessment) {
    super(`article_depth_gate:${assessment.reasons.join("|")}`);
    this.name = "ArticleDepthGateError";
  }
}
