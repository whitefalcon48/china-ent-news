import type { RawArticle } from "../types.js";

export type EvidenceIntegrityClass =
  | "primary"
  | "editorial_media"
  | "promotional_or_repost"
  | "platform_self_media"
  | "ai_generated";

export type EvidenceIntegrityDiagnostic = {
  evidence_ref: string;
  classification: EvidenceIntegrityClass;
  usable_for_verified_facts: boolean;
  reason: string;
  duplicate_of?: string;
};

const AI_DISCLOSURE = /(?:本文|本文章|以上文章内容|以上文章內容|内容|內容).{0,12}由AI生成|AI生成特别声明|AI生成特別声明|generated\s+by\s+AI/iu;
const SELF_MEDIA_URL = /(?:163\.com\/dy\/article|k\.sina\.com\.cn\/article_|sohu\.com\/a\/\d+_\d+)/iu;
const SELF_MEDIA_MARKER = /网易号|網易号|申请入驻|申請入駐|自媒体|自媒體/iu;
const PROMOTIONAL_MARKERS = [
  /盼星星盼月亮/iu,
  /爆笑来袭|引爆期待|强势来袭|重磅上线/iu,
  /这阵容你期待吗|誰頂得住|谁顶得住/iu,
  /坐等开播|坐等開播|相当能打|市場期待值頗高|市场期待值颇高/iu,
  /有望.{0,12}(掀起|成为|成為)|被市场普遍看好|被市場普遍看好/iu
];

/**
 * Describes whether a fetched document can establish a fact. It does not
 * decide whether a topic is interesting and never upgrades a source merely
 * because several portals repeat the same copy.
 */
export function assessEvidenceIntegrity(evidence: RawArticle[]): EvidenceIntegrityDiagnostic[] {
  const diagnostics = evidence.map((article, index) => assessOne(article, index));
  for (let index = 0; index < evidence.length; index += 1) {
    const duplicateIndex = evidence.findIndex((candidate, candidateIndex) =>
      candidateIndex < index && contentContainment(articleText(evidence[index]!), articleText(candidate)) >= 0.82
    );
    if (duplicateIndex < 0) continue;
    const current = diagnostics[index]!;
    if (current.classification === "primary") continue;
    diagnostics[index] = {
      ...current,
      classification: "promotional_or_repost",
      usable_for_verified_facts: false,
      reason: "near_duplicate_repost",
      duplicate_of: `E${duplicateIndex + 1}`
    };
  }
  return diagnostics;
}

export function evidenceIntegrityMap(evidence: RawArticle[]) {
  return Object.fromEntries(assessEvidenceIntegrity(evidence).map((item) => [item.evidence_ref, item]));
}

function assessOne(article: RawArticle, index: number): EvidenceIntegrityDiagnostic {
  const text = articleText(article);
  const base = { evidence_ref: `E${index + 1}` };
  if (AI_DISCLOSURE.test(text)) {
    return { ...base, classification: "ai_generated", usable_for_verified_facts: false, reason: "explicit_ai_generation_disclosure" };
  }
  if (SELF_MEDIA_URL.test(article.url) && SELF_MEDIA_MARKER.test(text)) {
    return { ...base, classification: "platform_self_media", usable_for_verified_facts: false, reason: "platform_self_media_page" };
  }
  if (article.sourceType === "official" || article.declaredSourceType === "official" || article.sourceType === "data") {
    return { ...base, classification: "primary", usable_for_verified_facts: true, reason: "official_or_primary_data_source" };
  }
  if (PROMOTIONAL_MARKERS.filter((pattern) => pattern.test(text)).length >= 2) {
    return { ...base, classification: "promotional_or_repost", usable_for_verified_facts: false, reason: "promotional_copy_without_independent_reporting" };
  }
  if (article.reliability === "A" || article.reliability === "B" || article.reliability === "C") {
    return { ...base, classification: "editorial_media", usable_for_verified_facts: true, reason: "editorial_source_without_integrity_markers" };
  }
  return { ...base, classification: "promotional_or_repost", usable_for_verified_facts: false, reason: "low_reliability_unverified_source" };
}

function articleText(article: RawArticle) {
  return `${article.title}\n${article.rawContent || article.excerpt || ""}`;
}

function contentContainment(left: string, right: string) {
  const leftShingles = shingles(normalize(left));
  const rightShingles = shingles(normalize(right));
  const smaller = leftShingles.size <= rightShingles.size ? leftShingles : rightShingles;
  const larger = smaller === leftShingles ? rightShingles : leftShingles;
  if (smaller.size < 20) return 0;
  return [...smaller].filter((value) => larger.has(value)).length / smaller.size;
}

function shingles(value: string) {
  const result = new Set<string>();
  for (let index = 0; index <= value.length - 8; index += 1) result.add(value.slice(index, index + 8));
  return result;
}

function normalize(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/新浪首页|网易首页|腾讯新闻|Copyright|版权所有/giu, "")
    .replace(/[^\p{Script=Han}a-z0-9]/giu, "")
    .toLowerCase();
}
