import Parser from "rss-parser";
import type {
  SourceExpansionAttempt,
  SourceExpansionEvidence,
  SourceExpansionResult,
  SourceTypeLabel,
  TopicCandidate
} from "./types.js";
import { areTitlesSimilar } from "./dedupe.js";

const DEFAULT_RSSHUB_BASE_URL = "https://rsshub.app";
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_TOPICS = 8;
const DEFAULT_QUERIES_PER_TOPIC = 2;
const MAX_ITEMS_PER_ROUTE = 8;
const SERPER_ENDPOINT = "https://api.serper.dev/search";

type ExpansionRoute = {
  id: string;
  sourceName: string;
  sourceType: SourceTypeLabel;
  routeTemplate: string;
};

type RssItem = {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
};

type SerperOrganicItem = {
  title?: string;
  link?: string;
  snippet?: string;
};

const DEFAULT_ROUTES: ExpansionRoute[] = [
  {
    id: "weibo-search",
    sourceName: "微博搜索",
    sourceType: "sns",
    routeTemplate: "/weibo/search/{query}"
  },
  {
    id: "douban-movie-search",
    sourceName: "豆瓣搜索",
    sourceType: "data",
    routeTemplate: "/douban/movie/search/{query}"
  },
  {
    id: "bilibili-search",
    sourceName: "Bilibili搜索",
    sourceType: "sns",
    routeTemplate: "/bilibili/search/{query}"
  }
];

export async function expandTopicSources(topicCandidates: TopicCandidate[]) {
  const skipRsshub = process.env.SOURCE_EXPANSION_SKIP_RSSHUB === "true";
  const routes = skipRsshub ? [] : getExpansionRoutes();
  const topics = topicCandidates
    .filter((topic) => ["today", "yesterday", "recent"].includes(topic.freshness_label))
    .sort((a, b) => b.newsworthiness_score - a.newsworthiness_score || a.topic_key.localeCompare(b.topic_key, "ja"))
    .slice(0, getMaxTopics());
  const attempts: SourceExpansionAttempt[] = [];
  const evidenceByTopic = new Map<string, SourceExpansionEvidence[]>();

  if (!topics.length || process.env.SOURCE_EXPANSION_ENABLED === "false") {
    return {
      topicCandidates,
      expansion: {
        shortlisted_topic_keys: [],
        attempted_topic_count: 0,
        attempted_route_count: 0,
        success_route_count: 0,
        evidence_count: 0,
        attempts: [],
        evidence: []
      } satisfies SourceExpansionResult
    };
  }

  for (const topic of topics) {
    const queries = getTopicQueries(topic).slice(0, getQueriesPerTopic());
    for (const query of queries) {
      if (skipRsshub) {
        const serperAttempt = await fetchSerperSearch(topic, query);
        attempts.push(serperAttempt.attempt);
        if (serperAttempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
        }
        continue;
      }
      const rssAttempts: SourceExpansionAttempt[] = [];
      for (const route of routes) {
        const attempt = await fetchExpansionRoute(topic, query, route);
        attempts.push(attempt.attempt);
        rssAttempts.push(attempt.attempt);
        if (attempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...attempt.evidence]);
        }
      }
      if (rssAttempts.length && rssAttempts.every((attempt) => attempt.fetch_status === "failed")) {
        const serperAttempt = await fetchSerperSearch(topic, query);
        attempts.push(serperAttempt.attempt);
        if (serperAttempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
        }
      }
    }
  }

  const evidence = [...evidenceByTopic.values()].flat();
  const expandedTopics = topicCandidates.map((topic) => attachExpansionEvidence(topic, evidenceByTopic.get(topic.topic_key) ?? []));
  const expansion: SourceExpansionResult = {
    shortlisted_topic_keys: topics.map((topic) => topic.topic_key),
    attempted_topic_count: topics.length,
    attempted_route_count: attempts.length,
    success_route_count: attempts.filter((attempt) => attempt.fetch_status === "success").length,
    evidence_count: evidence.length,
    attempts,
    evidence
  };

  return { topicCandidates: expandedTopics, expansion };
}

async function fetchSerperSearch(topic: TopicCandidate, query: string) {
  const common = {
    topic_key: topic.topic_key,
    query,
    route_id: "serper-search",
    route: SERPER_ENDPOINT,
    rsshub_base_url: "",
    source_type: "media_report" as const
  };
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey?.trim()) {
    return {
      attempt: {
        ...common,
        fetch_status: "skipped",
        fetch_error: "SERPER_API_KEY is not set",
        raw_count: 0,
        matched_count: 0,
        failure_stage: "not_configured"
      } satisfies SourceExpansionAttempt,
      evidence: []
    };
  }

  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-KEY": apiKey
      },
      body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 10 }),
      signal: AbortSignal.timeout(getTimeoutMs())
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as { organic?: SerperOrganicItem[] };
    const items = (payload.organic ?? []).slice(0, 10);
    const evidence = items.map((item) => toSerperEvidence(item, query)).filter((item) => isUsefulEvidence(topic, query, item));
    return {
      attempt: {
        ...common,
        fetch_status: items.length ? "success" : "empty",
        fetch_error: "",
        raw_count: items.length,
        matched_count: evidence.length,
        failure_stage: items.length ? "" : "serper_empty"
      } satisfies SourceExpansionAttempt,
      evidence
    };
  } catch (error) {
    return {
      attempt: {
        ...common,
        fetch_status: "failed",
        fetch_error: describeFetchError(error),
        raw_count: 0,
        matched_count: 0,
        failure_stage: getFailureStage(error)
      } satisfies SourceExpansionAttempt,
      evidence: []
    };
  }
}

function toSerperEvidence(item: SerperOrganicItem, query: string): SourceExpansionEvidence {
  const url = item.link ?? "";
  const hostname = getHostname(url);
  return {
    title: cleanText(item.title ?? ""),
    url,
    source_name: hostname || "Serper検索",
    source_type: getSerperSourceType(hostname),
    route_id: "serper-search",
    route: SERPER_ENDPOINT,
    query,
    key_points: [cleanText(item.title ?? ""), cleanText(item.snippet ?? "")].filter(Boolean)
  };
}

function getSerperSourceType(hostname: string): SourceTypeLabel {
  if (/(^|\.)weibo\.com$/.test(hostname) || /(^|\.)bilibili\.com$/.test(hostname)) return "sns";
  if (/(^|\.)douban\.com$/.test(hostname) || /(^|\.)maoyan\.com$/.test(hostname) || /piaofang/.test(hostname)) return "data";
  return "media_report";
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function fetchExpansionRoute(topic: TopicCandidate, query: string, route: ExpansionRoute) {
  const baseUrl = process.env.RSSHUB_BASE_URL ?? DEFAULT_RSSHUB_BASE_URL;
  const routePath = buildRoute(route.routeTemplate, query);
  const common = {
    topic_key: topic.topic_key,
    query,
    route_id: route.id,
    route: routePath,
    rsshub_base_url: baseUrl,
    source_type: route.sourceType
  };

  try {
    const xml = await fetchText(new URL(routePath, ensureTrailingSlash(baseUrl)).toString());
    const parser = new Parser();
    const feed = await parser.parseString(xml);
    const items = ((feed.items ?? []) as RssItem[]).slice(0, MAX_ITEMS_PER_ROUTE);
    const evidence = items.map((item) => toEvidence(item, route, routePath, query)).filter((item) => isUsefulEvidence(topic, query, item));

    return {
      attempt: {
        ...common,
        fetch_status: items.length ? "success" : "empty",
        fetch_error: "",
        raw_count: items.length,
        matched_count: evidence.length,
        failure_stage: items.length ? "" : "rss_parse_empty"
      } satisfies SourceExpansionAttempt,
      evidence
    };
  } catch (error) {
    return {
      attempt: {
        ...common,
        fetch_status: "failed",
        fetch_error: describeFetchError(error),
        raw_count: 0,
        matched_count: 0,
        failure_stage: getFailureStage(error)
      } satisfies SourceExpansionAttempt,
      evidence: []
    };
  }
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase2/0.1)"
    },
    signal: AbortSignal.timeout(getTimeoutMs())
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function attachExpansionEvidence(topic: TopicCandidate, evidence: SourceExpansionEvidence[]): TopicCandidate {
  if (!evidence.length) {
    return topic;
  }

  const existingKeys = new Set(topic.evidence_articles.map((article) => article.url || `${article.source_name}:${article.title}`));
  const acceptedTitles = topic.evidence_articles.map((article) => article.title);
  const newEvidence = evidence
    .filter((item) => {
      const key = item.url || `${item.source_name}:${item.title}`;
      if (existingKeys.has(key)) {
        return false;
      }
      if (acceptedTitles.some((title) => areTitlesSimilar(title, item.title))) return false;
      existingKeys.add(key);
      acceptedTitles.push(item.title);
      return true;
    })
    .map((item) => ({
      title: item.title,
      url: item.url,
      source_name: item.source_name,
      source_type: item.source_type,
      published_date: "",
      freshness_label: "unknown" as const,
      article_type: item.source_type === "sns" ? ("sns_trend" as const) : ("unknown" as const),
      reliability: "C" as const,
      key_points: item.key_points
    }));

  if (!newEvidence.length) {
    return topic;
  }

  const sourceNames = new Set([...topic.evidence_articles.map((article) => article.source_name), ...newEvidence.map((article) => article.source_name)]);
  const sourceMix = { ...topic.source_mix };
  for (const item of newEvidence) {
    sourceMix[item.source_type] = (sourceMix[item.source_type] ?? 0) + 1;
  }

  return {
    ...topic,
    source_count: sourceNames.size,
    source_mix: sourceMix,
    evidence_articles: [...topic.evidence_articles, ...newEvidence],
    signals: {
      ...topic.signals,
      has_data_signal: topic.signals.has_data_signal || newEvidence.some((item) => item.source_type === "data"),
      has_hot_search_signal: topic.signals.has_hot_search_signal || newEvidence.some((item) => item.source_type === "sns"),
      has_multiple_sources: sourceNames.size > 1
    },
    selection_reason: `${topic.selection_reason}, expansion_evidence:${newEvidence.length}`
  };
}

function toEvidence(item: RssItem, route: ExpansionRoute, routePath: string, query: string): SourceExpansionEvidence {
  const title = cleanText(item.title ?? "");
  const description = cleanText(item.contentSnippet ?? item.summary ?? stripHtml(item.content ?? ""));
  return {
    title,
    url: item.link ?? "",
    source_name: route.sourceName,
    source_type: route.sourceType,
    route_id: route.id,
    route: routePath,
    query,
    key_points: [title, description].filter(Boolean).slice(0, 2)
  };
}

function isUsefulEvidence(topic: TopicCandidate, query: string, evidence: SourceExpansionEvidence) {
  if (!evidence.title || !evidence.url) {
    return false;
  }
  const text = `${evidence.title} ${evidence.key_points.join(" ")}`;
  const tokens = getMatchTokens(topic, query);
  return tokens.some((token) => text.includes(token));
}

function getMatchTokens(topic: TopicCandidate, query: string) {
  const entityTokens = [
    ...topic.main_entities.works,
    ...topic.main_entities.people,
    ...topic.main_entities.organizations,
    ...topic.main_entities.events
  ];
  return [...new Set([topic.topic_key, query, ...entityTokens].map(normalizeToken).filter((token) => token.length >= 2))];
}

function getTopicQueries(topic: TopicCandidate) {
  return [...new Set([topic.topic_key, ...topic.search_queries].map((query) => query.trim()).filter(Boolean))];
}

function getExpansionRoutes() {
  const configured = parseRouteConfig(process.env.SOURCE_EXPANSION_RSS_ROUTES);
  return configured.length ? configured : DEFAULT_ROUTES;
}

function parseRouteConfig(value?: string) {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, sourceName, sourceType, routeTemplate] = part.split("|").map((valuePart) => valuePart.trim());
      if (!id || !sourceName || !routeTemplate) {
        return undefined;
      }
      return {
        id,
        sourceName,
        sourceType: isSourceType(sourceType) ? sourceType : "media_report",
        routeTemplate
      } satisfies ExpansionRoute;
    })
    .filter((route): route is ExpansionRoute => Boolean(route));
}

function isSourceType(value: string): value is SourceTypeLabel {
  return ["official", "media_report", "sns", "data", "pr_like", "rumor", "mixed"].includes(value);
}

function buildRoute(template: string, query: string) {
  const encodedQuery = encodeURIComponent(query);
  const route = template.replaceAll("{query}", encodedQuery);
  return route.startsWith("/") ? route : `/${route}`;
}

function getMaxTopics() {
  const value = Number(process.env.SOURCE_EXPANSION_MAX_TOPICS ?? DEFAULT_MAX_TOPICS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOPICS;
}

function getQueriesPerTopic() {
  const value = Number(process.env.SOURCE_EXPANSION_QUERIES_PER_TOPIC ?? DEFAULT_QUERIES_PER_TOPIC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUERIES_PER_TOPIC;
}

function getTimeoutMs() {
  const value = Number(process.env.SOURCE_EXPANSION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function getFailureStage(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "fetch_timeout";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "fetch_timeout";
  }
  if (error instanceof Error && /^HTTP \d+/.test(error.message)) {
    return "http_error";
  }
  if (error instanceof Error && /Invalid|Non-whitespace|XML|parse/i.test(error.message)) {
    return "rss_parse_error";
  }
  return "fetch_error";
}

function describeFetchError(error: unknown) {
  if (error instanceof Error) {
    const cause = "cause" in error && error.cause instanceof Error ? ` cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

function normalizeToken(value: string) {
  return value.replace(/[《》『』"'“”‘’\s]/g, "").trim();
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
