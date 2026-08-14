import type { FactLedger, RawArticle, TopicCandidate } from "./types.js";

export type LedgerAdequacyAssessment = {
  passed: boolean;
  required_root_claims: number;
  root_claims: number;
  editorial_roles: string[];
  reasons: string[];
};

export function assessLedgerAdequacy(ledger: FactLedger, topic: TopicCandidate, evidence: RawArticle[] = []): LedgerAdequacyAssessment {
  const rootClaims = ledger.claims.filter((claim) => claim.type !== "unsupported" && claim.scope !== "related_angle" && claim.anchor !== false);
  const roles = [...new Set(rootClaims.map((claim) => claim.editorial_role).filter((role): role is NonNullable<typeof role> => Boolean(role) && role !== "other"))];
  const dataRich = topic.topic_type === "box_office" || topic.context_value === "high" || evidence.some((item) => item.articleType === "data_report");
  const requiredRootClaims = dataRich ? 6 : 3;
  const reasons: string[] = [];
  if (rootClaims.length < requiredRootClaims) reasons.push(`root_claims:${rootClaims.length}<${requiredRootClaims}`);
  if (dataRich && roles.length < 2) reasons.push(`editorial_roles:${roles.length}<2`);
  if (dataRich && !roles.includes("key_numbers")) reasons.push("missing_editorial_role:key_numbers");
  return {
    passed: reasons.length === 0,
    required_root_claims: requiredRootClaims,
    root_claims: rootClaims.length,
    editorial_roles: roles,
    reasons
  };
}

export class LedgerAdequacyGateError extends Error {
  constructor(public readonly assessment: LedgerAdequacyAssessment) {
    super(`ledger_adequacy_gate:${assessment.reasons.join("|")}`);
    this.name = "LedgerAdequacyGateError";
  }
}
