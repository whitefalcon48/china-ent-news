import type { FactLedger, FactLedgerClaim } from "./types.js";

const INSIGHT_ROLES = new Set<NonNullable<FactLedgerClaim["editorial_role"]>>([
  "story_premise",
  "genre_contrast",
  "comic_mechanism",
  "modern_life_bridge",
  "adaptation_context",
  "audience_evidence",
  "source_caution"
]);

export function selectEditorialInsightClaims(ledger: FactLedger, bodyClaimRefs: string[] = []) {
  const body = new Set(bodyClaimRefs);
  return ledger.claims
    .filter((claim) => claim.type !== "unsupported" && claim.anchor !== false && !body.has(claim.id))
    .filter((claim) => INSIGHT_ROLES.has(claim.editorial_role ?? "other"))
    .sort((left, right) => roleRank(left.editorial_role) - roleRank(right.editorial_role))
    .slice(0, 8);
}

export function isEditorialInsightClaim(claim: FactLedgerClaim) {
  return INSIGHT_ROLES.has(claim.editorial_role ?? "other");
}

function roleRank(role: FactLedgerClaim["editorial_role"]) {
  const order: NonNullable<FactLedgerClaim["editorial_role"]>[] = [
    "genre_contrast",
    "comic_mechanism",
    "story_premise",
    "modern_life_bridge",
    "adaptation_context",
    "audience_evidence",
    "source_caution"
  ];
  const index = order.indexOf(role ?? "other");
  return index < 0 ? order.length : index;
}
