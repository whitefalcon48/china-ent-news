import fs from "node:fs/promises";
import path from "node:path";
import type { MainEntities, ProcessedArticle, ReviewReasonTag, ReviewState, TopicType } from "./types.js";
import type { TopicCandidate } from "./types.js";
import { getTopicMatchSpecificity } from "./topicKey.js";

export type PublicationHistoryStatus = "approved" | "rejected" | "revision_requested" | "pending";

export type PublicationHistoryEntry = {
  date: string;
  topic_key: string;
  title: string;
  status: PublicationHistoryStatus;
  reason_tag: ReviewReasonTag;
  entities: MainEntities;
  topic_type: TopicType;
  evidence_urls: string[];
};

export type PublicationHistory = {
  loaded_days: string[];
  entries: PublicationHistoryEntry[];
};

export type SubstantiveUpdate = "none" | "official_decision" | "principal_response" | "result";

export type PublicationHistoryMatch = {
  topic_key: string;
  matched_date: string;
  matched_key: string;
  matched_status: PublicationHistoryStatus;
  reason_tag: ReviewReasonTag;
  substantive_update: SubstantiveUpdate;
  update_evidence_urls: string[];
  decision: "reselect_allowed" | "dup_no_update";
};

export async function loadPublicationHistory(referenceDate: string, days = 5, dataRoot = "data"): Promise<PublicationHistory> {
  const loadedDays: string[] = [];
  const entries: PublicationHistoryEntry[] = [];

  for (const date of previousDates(referenceDate, days)) {
    const directory = path.resolve(dataRoot, date);
    const review = await readJson<ReviewState>(path.join(directory, "review.json"));
    if (!review?.articles?.length) continue;

    const articleFile = await findArticlesFile(directory, date);
    const articles = articleFile ? await readJson<ProcessedArticle[]>(articleFile) : undefined;
    if (!Array.isArray(articles)) continue;

    loadedDays.push(date);
    const byTopicKey = new Map(articles.map((article) => [getArticleTopicKey(article), article]).filter((item): item is [string, ProcessedArticle] => Boolean(item[0])));
    for (const reviewed of review.articles) {
      const article = byTopicKey.get(reviewed.topic_key);
      if (!article) continue;
      entries.push({
        date,
        topic_key: reviewed.topic_key,
        title: reviewed.title || article.summary?.title_ja || article.raw.title,
        status: normalizeStatus(reviewed.status),
        reason_tag: reviewed.reason_tag,
        entities: getEntities(article),
        topic_type: article.topic?.topic_type ?? "unknown",
        evidence_urls: getEvidenceUrls(article)
      });
    }
  }

  return { loaded_days: loadedDays, entries };
}

export function evaluateTopicHistory(topic: TopicCandidate, history: PublicationHistory): PublicationHistoryMatch | undefined {
  const matched = history.entries
    .map((entry) => ({ entry, specificity: getTopicMatchSpecificity(topic, entry) }))
    .filter((item) => item.specificity > 0)
    .sort((a, b) => b.specificity - a.specificity || b.entry.topic_key.length - a.entry.topic_key.length)[0]?.entry;
  if (!matched) return undefined;
  const oldUrls = new Set(matched.evidence_urls);
  const newEvidence = topic.evidence_articles.filter((evidence) =>
    evidence.url
    && !oldUrls.has(evidence.url)
    && Boolean(evidence.published_date)
    && ["today", "yesterday", "recent"].includes(evidence.freshness_label)
  );
  const substantiveUpdate = detectSubstantiveUpdate(newEvidence.map((evidence) => `${evidence.title} ${evidence.key_points.join(" ")}`).join(" "));
  return {
    topic_key: topic.topic_key,
    matched_date: matched.date,
    matched_key: matched.topic_key,
    matched_status: matched.status,
    reason_tag: matched.reason_tag,
    substantive_update: substantiveUpdate,
    update_evidence_urls: newEvidence.map((evidence) => evidence.url),
    decision: substantiveUpdate === "none" ? "dup_no_update" : "reselect_allowed"
  };
}

function detectSubstantiveUpdate(text: string): SubstantiveUpdate {
  if (!text.trim()) return "none";
  if (/官宣|定档|立项|批准|获奖|得奖|夺冠|判决|处罚|立案|声明|公告/.test(text)) return "official_decision";
  if (/回应|本人|受访|发文|发声|承认|否认/.test(text)) return "principal_response";
  if (/开播|首播|上映|收官|大结局|突破|破.{0,3}亿|夺冠|登顶/.test(text)) return "result";
  return "none";
}

function previousDates(referenceDate: string, days: number) {
  const base = new Date(`${referenceDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return [];
  return Array.from({ length: days }, (_, index) => {
    const value = new Date(base);
    value.setUTCDate(value.getUTCDate() - index - 1);
    return value.toISOString().slice(0, 10);
  });
}

async function findArticlesFile(directory: string, date: string) {
  try {
    const names = await fs.readdir(directory);
    return names.find((name) => name === `articles_${date}.json`)
      ? path.join(directory, `articles_${date}.json`)
      : names.filter((name) => /^articles_.*\.json$/.test(name)).sort().at(-1)
        ? path.join(directory, names.filter((name) => /^articles_.*\.json$/.test(name)).sort().at(-1)!)
        : "";
  } catch {
    return "";
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function getArticleTopicKey(article: ProcessedArticle) {
  return article.topic?.topic_key ?? article.summary?.topic_key ?? article.raw.topicKey ?? "";
}

function getEntities(article: ProcessedArticle): MainEntities {
  const entities = article.topic?.main_entities ?? article.summary?.main_entities ?? article.raw.mainEntities;
  return {
    people: [...(entities?.people ?? [])],
    works: [...(entities?.works ?? [])],
    organizations: [...(entities?.organizations ?? [])]
  };
}

function getEvidenceUrls(article: ProcessedArticle) {
  return [...new Set([
    ...(article.topic?.evidence_articles.map((evidence) => evidence.url) ?? []),
    ...(article.summary?.source_list.map((source) => source.url ?? "") ?? []),
    article.raw.url
  ].filter(Boolean))];
}

function normalizeStatus(status: string): PublicationHistoryStatus {
  if (status === "approved" || status === "rejected" || status === "revision_requested" || status === "pending") return status;
  return status === "revised_pending" ? "revision_requested" : "pending";
}
