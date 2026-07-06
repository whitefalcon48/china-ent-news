import fs from "node:fs/promises";
import path from "node:path";
import { createTopicKey as createSharedTopicKey, extractEventName, extractPersonName, extractWorkName } from "./topicKey.js";
import type {
  ArticleType,
  ContextValue,
  FeedBadge,
  FreshnessLabel,
  LevelLabel,
  MainEntities,
  PublishPriority,
  RawArticle,
  SourceTypeLabel,
  SourceExpansionResult,
  TopicCandidate,
  TopicSeed,
  TopicSeedExtractionResult,
  TopicType
} from "./types.js";

const FRESHNESS_ORDER: FreshnessLabel[] = ["today", "yesterday", "recent", "stale", "old", "background", "unknown"];
const SOURCE_TYPES: SourceTypeLabel[] = ["official", "media_report", "sns", "data", "pr_like", "rumor", "mixed"];

type TopicEntry = {
  article: RawArticle;
  seed?: TopicSeed;
};

export function buildTopicCandidates(articles: RawArticle[], seeds: TopicSeed[] = []): TopicCandidate[] {
  const groups = new Map<string, TopicEntry[]>();
  const seedByUrl = new Map(seeds.map((seed) => [seed.article_url, seed]));

  for (const article of articles) {
    const seed = seedByUrl.get(article.url);
    const topicKey = seed?.topic_key || createTopicKey(article);
    const group = groups.get(topicKey) ?? [];
    group.push({ article, seed });
    groups.set(topicKey, group);
  }

  return [...groups.entries()]
    .map(([topicKey, group]) => buildTopicCandidate(topicKey, group))
    .sort((a, b) => b.newsworthiness_score - a.newsworthiness_score || b.source_count - a.source_count || a.topic_key.localeCompare(b.topic_key, "ja"));
}

export async function writeTopicCandidatesFile(
  topicCandidates: TopicCandidate[],
  date = today(),
  meta: { topic_seed_extraction?: TopicSeedExtractionResult; source_expansion?: SourceExpansionResult } = {}
) {
  const outputPath = path.resolve("output", `topic_candidates_${date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(
      {
        date,
        generated_at: new Date().toISOString(),
        topic_seed_extraction: meta.topic_seed_extraction,
        source_expansion: meta.source_expansion,
        topic_candidates_count: topicCandidates.length,
        topic_candidates: topicCandidates
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return outputPath;
}

function buildTopicCandidate(topicKey: string, entries: TopicEntry[]): TopicCandidate {
  const articles = entries.map((entry) => entry.article);
  const seeds = entries.map((entry) => entry.seed).filter((seed): seed is TopicSeed => Boolean(seed));
  const representativeSeed = chooseRepresentativeSeed(seeds);
  const sortedArticles = [...articles].sort(compareEvidenceArticles);
  const representative = sortedArticles[0];
  const dates = sortedArticles.map((article) => article.publishedDate).filter(Boolean).sort();
  const sourceTypes = sortedArticles.map((article) => getSourceType(article));
  const sourceMix = countSourceTypes(sourceTypes);
  const topicType = inferTopicType(sortedArticles);
  const signals = {
    has_official_source: sourceTypes.includes("official") || sourceTypes.includes("pr_like"),
    has_media_context: sourceTypes.includes("media_report") || sourceTypes.includes("data"),
    has_data_signal: sourceTypes.includes("data") || sortedArticles.some((article) => article.articleType === "data_report"),
    has_hot_search_signal: sourceTypes.includes("sns") || sortedArticles.some((article) => article.badge === "HOT SEARCH" || article.articleType === "sns_trend"),
    has_multiple_sources: new Set(sortedArticles.map((article) => article.sourceName)).size > 1
  };
  const score = getTopicScore(sortedArticles, signals, topicType);

  return {
    topic_key: topicKey,
    title_hint: representative?.title ?? topicKey,
    event_sentence: representativeSeed?.event_sentence ?? "",
    search_queries: mergeSearchQueries(seeds, topicKey),
    seed_source: seeds.some((seed) => seed.source === "llm") ? "llm" : "regex_fallback",
    seed_confidence: representativeSeed?.confidence ?? 0,
    topic_type: topicType,
    freshness_label: getTopicFreshness(sortedArticles),
    published_date_range: {
      earliest: dates[0] ?? "",
      latest: dates.at(-1) ?? ""
    },
    source_count: new Set(sortedArticles.map((article) => article.sourceName)).size,
    source_mix: sourceMix,
    evidence_articles: sortedArticles.map(toEvidenceArticle),
    main_entities: mergeEntities(sortedArticles, topicKey, seeds),
    signals,
    newsworthiness_score: score,
    japan_gap: getMaxLevel(sortedArticles.map((article) => article.japanGap ?? "unknown")),
    context_value: getMaxContextValue(sortedArticles.map((article) => article.contextValue ?? "low")),
    publish_priority: getPublishPriority(score),
    selection_reason: getSelectionReason(sortedArticles, signals, topicType),
    caution_note: getCautionNote(sortedArticles, signals)
  };
}

function createTopicKey(article: RawArticle) {
  return article.topicKey || createSharedTopicKey(article.title, article.excerpt ?? "");
}

function chooseRepresentativeSeed(seeds: TopicSeed[]) {
  return [...seeds].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "llm" ? -1 : 1;
    }
    return b.confidence - a.confidence;
  })[0];
}

function mergeSearchQueries(seeds: TopicSeed[], topicKey: string) {
  const queries = seeds.flatMap((seed) => seed.search_queries);
  return [...new Set([topicKey, ...queries].filter(Boolean))].slice(0, 5);
}

function inferTopicType(articles: RawArticle[]): TopicType {
  const text = articles.map((article) => `${article.title} ${article.excerpt ?? ""}`).join(" ");
  if (/备案|公示|管理办法|国家电影局|国家广播电视总局|广播电视|网络视听/.test(text)) return "policy";
  if (/网络剧|电视剧|微短剧/.test(text)) return "drama_production";
  if (/票房|猫眼|豆瓣|指数|数据|榜/.test(text)) return "box_office";
  if (/上映|定档|开播|播出|发布|预告|首映/.test(text)) return "release";
  if (/获奖|入围|提名|白玉兰|华表|金爵|金鸡/.test(text)) return "award";
  if (/主演|加盟|官宣|阵容|出任/.test(text)) return "casting";
  if (/热搜|粉丝|CP|番位|塌房|饭圈/.test(text)) return "fan_culture";
  if (/网传|疑似|传闻|回应|辟谣/.test(text)) return "gossip_rumor";
  if (/电影节|影展|文化交流|海外|国际/.test(text)) return "cultural_export";
  if (/平台|优酷|腾讯视频|爱奇艺|芒果TV|B站|抖音/.test(text)) return "platform_trend";
  if (/产业|行业|公司|市场|投资|制作/.test(text)) return "industry_context";
  return "unknown";
}

function getTopicFreshness(articles: RawArticle[]) {
  return [...articles]
    .map((article) => article.freshnessLabel ?? "unknown")
    .sort((a, b) => FRESHNESS_ORDER.indexOf(a) - FRESHNESS_ORDER.indexOf(b))[0];
}

function countSourceTypes(sourceTypes: SourceTypeLabel[]) {
  const counts = Object.fromEntries(SOURCE_TYPES.map((type) => [type, 0])) as Record<SourceTypeLabel, number>;
  for (const type of sourceTypes) {
    counts[type] += 1;
  }
  return counts;
}

function getSourceType(article: RawArticle): SourceTypeLabel {
  return article.sourceType ?? (article.reliability === "A" ? "official" : "media_report");
}

function toEvidenceArticle(article: RawArticle) {
  return {
    title: article.title,
    url: article.url,
    source_name: article.sourceName,
    source_type: getSourceType(article),
    published_date: article.publishedDate ?? "",
    freshness_label: article.freshnessLabel ?? "unknown",
    article_type: article.articleType ?? "unknown",
    reliability: article.reliability,
    key_points: buildKeyPoints(article)
  };
}

function buildKeyPoints(article: RawArticle) {
  return [article.title, article.excerpt ?? ""].filter(Boolean).slice(0, 2);
}

function mergeEntities(articles: RawArticle[], topicKey: string, seeds: TopicSeed[] = []): MainEntities & { events: string[] } {
  const people = new Set<string>();
  const works = new Set<string>();
  const organizations = new Set<string>();
  const events = new Set<string>();

  for (const seed of seeds) {
    for (const person of seed.entities.people) people.add(person);
    for (const work of seed.entities.works) works.add(work);
    for (const organization of seed.entities.organizations) organizations.add(organization);
    for (const event of seed.entities.events) events.add(event);
  }

  for (const article of articles) {
    for (const person of article.mainEntities?.people ?? []) people.add(person);
    for (const work of article.mainEntities?.works ?? []) works.add(work);
    for (const organization of article.mainEntities?.organizations ?? []) organizations.add(organization);
    const work = extractWorkName(article.title);
    const event = extractEventName(article.title);
    const person = extractPersonName(article.title);
    if (work) works.add(work);
    if (event) events.add(event);
    if (person) people.add(person);
  }

  if (!works.size && /《|『/.test(topicKey)) {
    works.add(topicKey);
  }
  return {
    people: [...people],
    works: [...works],
    organizations: [...organizations],
    events: [...events]
  };
}

function getTopicScore(articles: RawArticle[], signals: TopicCandidate["signals"], topicType: TopicType) {
  let score = Math.round(articles.reduce((sum, article) => sum + (article.newsworthinessScore ?? 40), 0) / Math.max(articles.length, 1));
  const hasNonOfficialContext = signals.has_media_context || signals.has_hot_search_signal || signals.has_data_signal;
  if (signals.has_multiple_sources) score += 12;
  if (signals.has_official_source && signals.has_media_context) score += 10;
  if (signals.has_hot_search_signal) score += 10;
  if (signals.has_data_signal) score += 6;
  // Official-only topics are collectable but low value for this project:
  // without media/SNS/data reaction there is no "local temperature" to report.
  if (signals.has_official_source && !hasNonOfficialContext) score -= 15;
  if ((topicType === "policy" || topicType === "drama_production") && hasNonOfficialContext) score += 6;
  if (topicType === "fan_culture") score += 6;
  if (articles.some((article) => article.isLowPriority)) score -= 8;
  return Math.max(0, Math.min(100, score));
}

function getPublishPriority(score: number): PublishPriority {
  if (score >= 76) return "high";
  if (score >= 56) return "medium";
  return "low";
}

function getSelectionReason(articles: RawArticle[], signals: TopicCandidate["signals"], topicType: TopicType) {
  const reasons: string[] = [];
  if (signals.has_multiple_sources) reasons.push("multiple_sources");
  if (signals.has_official_source) reasons.push("official_evidence");
  if (signals.has_media_context) reasons.push("media_context");
  if (signals.has_data_signal) reasons.push("data_signal");
  if (signals.has_hot_search_signal) reasons.push("hot_search_signal");
  reasons.push(`topic_type:${topicType}`);
  reasons.push(`evidence:${articles.length}`);
  return reasons.join(", ");
}

function getCautionNote(articles: RawArticle[], signals: TopicCandidate["signals"]) {
  if (signals.has_hot_search_signal && !signals.has_official_source && !signals.has_media_context) {
    return "SNS-derived topic only; do not treat as confirmed news.";
  }
  if (signals.has_official_source && !signals.has_media_context && !signals.has_hot_search_signal && !signals.has_data_signal) {
    return "Official-only topic; no media/SNS/data reaction found, so local temperature is unverified.";
  }
  if (!signals.has_multiple_sources) {
    return "Single-source topic; keep wording cautious until another source appears.";
  }
  if (articles.some((article) => article.sourceType === "pr_like")) {
    return "Contains PR-like or official framing; separate fact from promotion.";
  }
  return "";
}

function getMaxLevel(values: LevelLabel[]): LevelLabel {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  if (values.includes("low")) return "low";
  return "unknown";
}

function getMaxContextValue(values: ContextValue[]): ContextValue {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  return "low";
}

function compareEvidenceArticles(a: RawArticle, b: RawArticle) {
  return (b.newsworthinessScore ?? 0) - (a.newsworthinessScore ?? 0) || (a.publishedDate ?? "").localeCompare(b.publishedDate ?? "");
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
