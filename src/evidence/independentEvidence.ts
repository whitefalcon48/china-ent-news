import { areTitlesSimilar } from "../dedupe.js";
import { normalizeMediaFamily } from "./mediaFamily.js";

export type FamilyEvidence = {
  title: string;
  url: string;
  source_name: string;
  media_family?: string;
};

/**
 * Counts distinct reporting rather than distinct URLs. Syndication siblings
 * share one family; near-identical titles are also treated as one report.
 */
export function getIndependentEvidence<T extends FamilyEvidence>(evidence: T[]) {
  const accepted: T[] = [];
  for (const item of evidence) {
    const family = getEvidenceMediaFamily(item);
    if (accepted.some((candidate) => getEvidenceMediaFamily(candidate) === family)) continue;
    if (accepted.some((candidate) => areTitlesSimilar(candidate.title, item.title))) continue;
    accepted.push(item);
  }
  return accepted;
}

export function getEvidenceMediaFamily(item: FamilyEvidence) {
  const normalized = item.media_family?.trim() || normalizeMediaFamily(item.url || item.source_name);
  // Saved historic evidence can lack a URL. Keep differently named unknown
  // publishers separate instead of collapsing every old record into one.
  return normalized && normalized !== "unknown" ? normalized : `source:${item.source_name.trim().toLowerCase() || "unknown"}`;
}
