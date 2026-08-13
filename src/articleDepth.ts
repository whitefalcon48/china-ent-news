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
  const usedIds = new Set([
    ...summary.claim_refs.what_happened,
    ...summary.claim_refs.why_it_matters,
    ...summary.claim_refs.reaction_view,
    ...summary.claim_refs.japan_context_note
  ].filter((id) => validIds.has(id)));
  const numberClaims = eligible.filter((claim) => claim.numbers.length > 0);
  const usedNumberClaims = numberClaims.filter((claim) => usedIds.has(claim.id));
  const coverageRatio = eligible.length ? usedIds.size / eligible.length : 1;
  const reasons: string[] = [];

  if (profile === "manual_evidence_rich") {
    const minimumUsedClaims = eligible.length >= 10
      ? Math.max(6, Math.ceil(eligible.length * 0.6))
      : eligible.length >= 6
        ? Math.ceil(eligible.length * 0.6)
        : Math.min(eligible.length, 3);
    const minimumNumberClaims = numberClaims.length >= 4 ? Math.ceil(numberClaims.length * 0.6) : numberClaims.length;
    if (sections.length > 0) reasons.push(`unexpected_detail_sections:${sections.length}`);
    if (usedIds.size < minimumUsedClaims) reasons.push(`used_claims:${usedIds.size}<${minimumUsedClaims}`);
    if (usedNumberClaims.length < minimumNumberClaims) reasons.push(`used_number_claims:${usedNumberClaims.length}<${minimumNumberClaims}`);
    if (eligible.length >= 6 && summary.what_happened.trim().length < 220) reasons.push("what_happened_too_short");
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

export class ArticleDepthGateError extends Error {
  constructor(public readonly assessment: ArticleDepthAssessment) {
    super(`article_depth_gate:${assessment.reasons.join("|")}`);
    this.name = "ArticleDepthGateError";
  }
}
