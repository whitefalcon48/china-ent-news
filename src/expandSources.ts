import Parser from "rss-parser";
import { assessClaimCoverage, classifyEvidenceRisk, requiredIndependentEvidence } from "./evidence/claimCoverage.js";
import { extractDocumentSnapshot } from "./evidence/documentSnapshot.js";
import { normalizeMediaFamily } from "./evidence/mediaFamily.js";
import { getIndependentEvidence } from "./evidence/independentEvidence.js";
import type {
  SourceExpansionAttempt,
  SourceExpansionEvidence,
  SourceExpansionObservation,
  SourceExpansionResult,
  SourceResearchCandidate,
  SourceTypeLabel,
  TopicCandidate
} from "./types.js";
import { assessSourceRelevance, inferRelatedAngleKind, isSafePublicationSourceUrl, rankRelatedAngleSearchQueries, rankTopicSearchQueries, type SourceResearchLane } from "./sourceRelevance.js";

const DEFAULT_RSSHUB_BASE_URL = "https://rsshub.app";
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_TOPICS = 8;
const DEFAULT_QUERIES_PER_TOPIC = 2;
const DEFAULT_RELATED_ANGLE_TOPICS = 3;
const DEFAULT_RELATED_ANGLE_QUERIES_PER_TOPIC = 2;
const MAX_ITEMS_PER_ROUTE = 8;
const SERPER_ENDPOINT = "https://google.serper.dev/search";
const MAX_SERPER_RESULTS = 5;
const MAX_DOCUMENT_VALIDATIONS_PER_QUERY = 3;

export type SourceExpansionOptions = {
  /** Candidate-review integration can supply up to three high-interest topics. */
  preferenceExploration?: TopicCandidate[];
  /** Retained separately for an empty-day Issue; it never changes a publish gate. */
  emptyDay?: boolean;
  /** A review rescue may recheck only its bounded stored candidates. */
  maxTopics?: number;
  /** Use the already-configured Serper route directly instead of RSSHub. */
  forceSerper?: boolean;
  /** Manual intake can spend a few more bounded queries on verified reactions. */
  relatedAngleQueriesPerTopic?: number;
};

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

export type SerperOrganicItem = {
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

export async function expandTopicSources(topicCandidates: TopicCandidate[], options: SourceExpansionOptions = {}) {
  const skipRsshub = options.forceSerper || process.env.SOURCE_EXPANSION_SKIP_RSSHUB === "true";
  const routes = skipRsshub ? [] : getExpansionRoutes();
  const rankedTopics = topicCandidates
    .filter((topic) => ["today", "yesterday", "recent"].includes(topic.freshness_label))
    .sort((a, b) => b.newsworthiness_score - a.newsworthiness_score || a.topic_key.localeCompare(b.topic_key, "ja"))
    .slice(0, getMaxTopics(options.maxTopics));
  const baselineExpansionKeys = new Set(rankedTopics.map((topic) => topic.topic_key));
  // Preference exploration is a research allocation only.  It is never added
  // to the normal selection score and cannot bypass claim or review gates.
  const topics = uniqueTopics([...rankedTopics, ...(options.preferenceExploration ?? []).slice(0, 3)])
    .filter((topic) => ["today", "yesterday", "recent"].includes(topic.freshness_label));
  const attempts: SourceExpansionAttempt[] = [];
  const evidenceByTopic = new Map<string, SourceExpansionEvidence[]>();
  const observations: SourceExpansionObservation[] = [];

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
        evidence: [],
        corroboration_evidence_count: 0,
        related_angle_evidence_count: 0,
        observations: [],
        research_candidates: buildResearchCandidates(topicCandidates, options)
      } satisfies SourceExpansionResult
    };
  }

  for (const topic of topics) {
    const queries = getTopicQueries(topic).slice(0, getQueriesPerTopic());
    for (const query of queries) {
      if (skipRsshub) {
        const serperAttempt = await fetchSerperSearch(topic, query, "corroboration");
        attempts.push(serperAttempt.attempt);
        observations.push(...serperAttempt.observations);
        if (serperAttempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
        }
        continue;
      }
      const rssAttempts: SourceExpansionAttempt[] = [];
      for (const route of routes) {
        const attempt = await fetchExpansionRoute(topic, query, route, "corroboration");
        attempts.push(attempt.attempt);
        rssAttempts.push(attempt.attempt);
        observations.push(...attempt.observations);
        if (attempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...attempt.evidence]);
        }
      }
      if (rssAttempts.length && rssAttempts.every((attempt) => attempt.fetch_status === "failed")) {
        const serperAttempt = await fetchSerperSearch(topic, query, "corroboration");
        attempts.push(serperAttempt.attempt);
        observations.push(...serperAttempt.observations);
        if (serperAttempt.evidence.length) {
          evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
        }
      }
    }
  }

  // A second, deliberately small pass helps recover reader-interest topics
  // that have only one independent media family. It is discovery-only: these
  // results do not become corroborating evidence or change selection scores.
  const relatedAngleTopics = selectRelatedAngleTopics(topicCandidates, options);
  for (const topic of relatedAngleTopics) {
    const queries = rankRelatedAngleSearchQueries(topic).slice(0, getRelatedAngleQueriesPerTopic(options.relatedAngleQueriesPerTopic));
    for (const query of queries) {
      if (skipRsshub) {
        const serperAttempt = await fetchSerperSearch(topic, query, "related_angle");
        attempts.push(serperAttempt.attempt);
        observations.push(...serperAttempt.observations);
        if (serperAttempt.evidence.length) evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
        continue;
      }
      const rssAttempts: SourceExpansionAttempt[] = [];
      for (const route of routes) {
        const attempt = await fetchExpansionRoute(topic, query, route, "related_angle");
        attempts.push(attempt.attempt);
        rssAttempts.push(attempt.attempt);
        observations.push(...attempt.observations);
        if (attempt.evidence.length) evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...attempt.evidence]);
      }
      if (rssAttempts.length && rssAttempts.every((attempt) => attempt.fetch_status === "failed")) {
        const serperAttempt = await fetchSerperSearch(topic, query, "related_angle");
        attempts.push(serperAttempt.attempt);
        observations.push(...serperAttempt.observations);
        if (serperAttempt.evidence.length) evidenceByTopic.set(topic.topic_key, [...(evidenceByTopic.get(topic.topic_key) ?? []), ...serperAttempt.evidence]);
      }
    }
  }

  const evidence = [...evidenceByTopic.entries()]
    .flatMap(([topicKey, items]) => items.filter((item) => item.evidence_role === "related_angle" || baselineExpansionKeys.has(topicKey)));
  // Related-angle research remains visible even when it was preference-only.
  // Only corroboration from the baseline queue can attach to a topic, so this
  // diagnostic record cannot change candidate score, EVS, or publication.
  const expandedTopics = topicCandidates.map((topic) =>
    baselineExpansionKeys.has(topic.topic_key)
      ? attachExpansionEvidence(topic, evidenceByTopic.get(topic.topic_key) ?? [])
      // Preference/single-family research is allowed to retain a verified
      // related angle, but never its corroboration lane or selection fields.
      : attachExpansionEvidence(topic, (evidenceByTopic.get(topic.topic_key) ?? []).filter((item) => item.evidence_role === "related_angle"))
  );
  const expansion: SourceExpansionResult = {
    shortlisted_topic_keys: uniqueTopics([...topics, ...relatedAngleTopics]).map((topic) => topic.topic_key),
    attempted_topic_count: uniqueTopics([...topics, ...relatedAngleTopics]).length,
    attempted_route_count: attempts.length,
    success_route_count: attempts.filter((attempt) => attempt.fetch_status === "success").length,
    evidence_count: evidence.length,
    corroboration_evidence_count: evidence.filter((item) => item.evidence_role === "corroboration").length,
    related_angle_evidence_count: evidence.filter((item) => item.evidence_role === "related_angle").length,
    attempts,
    evidence,
    observations,
    research_candidates: buildResearchCandidates(topicCandidates, options)
  };

  return { topicCandidates: expandedTopics, expansion };
}

async function fetchSerperSearch(topic: TopicCandidate, query: string, lane: SourceResearchLane) {
  const common = {
    topic_key: topic.topic_key,
    query,
    route_id: "serper-search",
    route: SERPER_ENDPOINT,
    rsshub_base_url: "",
    source_type: "media_report" as const,
    evidence_role: lane
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
      evidence: [],
      observations: []
    };
  }

  try {
    const items = (await searchSerperOrganic(query)).slice(0, MAX_SERPER_RESULTS);
    const assessed = items.map((item) => toSerperEvidence(item, query, lane)).map((item) => ({ item, assessment: assessSourceRelevance(topic, item, query, lane) }));
    const validated = await validateDiscoveries(topic, assessed, query, lane);
    const evidence = validated.evidence;
    return {
      attempt: {
        ...common,
        fetch_status: items.length ? "success" : "empty",
        fetch_error: "",
        raw_count: items.length,
        matched_count: evidence.length,
        rejected_count: validated.observations.filter((item) => item.status === "rejected").length,
        rejection_reasons: countRejectionReasons(assessed, validated.observations),
        failure_stage: items.length ? "" : "serper_empty"
      } satisfies SourceExpansionAttempt,
      evidence,
      observations: validated.observations
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
      evidence: [],
      observations: []
    };
  }
}

export async function searchSerperOrganic(query: string): Promise<SerperOrganicItem[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey?.trim()) throw new Error("SERPER_API_KEY is not set");
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
  return payload.organic ?? [];
}

function toSerperEvidence(item: SerperOrganicItem, query: string, lane: SourceResearchLane): SourceExpansionEvidence {
  const url = item.link ?? "";
  const hostname = getHostname(url);
  const title = cleanText(item.title ?? "");
  const snippet = cleanText(item.snippet ?? "");
  return {
    title,
    url,
    source_name: hostname || "Serper検索",
    source_type: getSerperSourceType(hostname),
    route_id: "serper-search",
    route: SERPER_ENDPOINT,
    query,
    evidence_role: lane,
    // The snippet is discovery-only. validateDiscoveredEvidence replaces
    // key_points with fetched page text before it can reach the fact ledger.
    key_points: [title, snippet].filter(Boolean),
    validation_status: "discovered",
    media_family: normalizeMediaFamily(url)
  };
}

function getSerperSourceType(hostname: string): SourceTypeLabel {
  if (/(^|\.)(?:people\.com\.cn|peopleapp\.com)$/.test(hostname)) return "official";
  if (/(^|\.)(?:youku\.com|iqiyi\.com|qidian\.com)$/.test(hostname)) return "official";
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

async function fetchExpansionRoute(topic: TopicCandidate, query: string, route: ExpansionRoute, lane: SourceResearchLane) {
  const baseUrl = process.env.RSSHUB_BASE_URL ?? DEFAULT_RSSHUB_BASE_URL;
  const routePath = buildRoute(route.routeTemplate, query);
  const common = {
    topic_key: topic.topic_key,
    query,
    route_id: route.id,
    route: routePath,
    rsshub_base_url: baseUrl,
    source_type: route.sourceType,
    evidence_role: lane
  };

  try {
    const xml = await fetchText(new URL(routePath, ensureTrailingSlash(baseUrl)).toString());
    const parser = new Parser();
    const feed = await parser.parseString(xml);
    const items = ((feed.items ?? []) as RssItem[]).slice(0, MAX_ITEMS_PER_ROUTE);
    const assessed = items.map((item) => toEvidence(item, route, routePath, query, lane)).map((item) => ({ item, assessment: assessSourceRelevance(topic, item, query, lane) }));
    const validated = await validateDiscoveries(topic, assessed, query, lane);
    const evidence = validated.evidence;

    return {
      attempt: {
        ...common,
        fetch_status: items.length ? "success" : "empty",
        fetch_error: "",
        raw_count: items.length,
        matched_count: evidence.length,
        rejected_count: validated.observations.filter((item) => item.status === "rejected").length,
        rejection_reasons: countRejectionReasons(assessed, validated.observations),
        failure_stage: items.length ? "" : "rss_parse_empty"
      } satisfies SourceExpansionAttempt,
      evidence,
      observations: validated.observations
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
      evidence: [],
      observations: []
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

export function attachExpansionEvidence(topic: TopicCandidate, evidence: SourceExpansionEvidence[]): TopicCandidate {
  if (!evidence.length) {
    return topic;
  }

  // A related angle has its own verified provenance and must never boost the
  // root candidate's source count, source mix, signals, EVS, or selection.
  const existingRelatedKeys = new Set((topic.related_evidence_articles ?? []).map((article) => article.url || `${article.source_name}:${article.title}`));
  const relatedEvidence = evidence
    .filter((item) => item.evidence_role === "related_angle")
    .filter((item) => item.validation_status === "verified")
    .filter((item) => {
      const key = item.url || `${item.source_name}:${item.title}`;
      if (existingRelatedKeys.has(key)) return false;
      existingRelatedKeys.add(key);
      return true;
    })
    .map((item) => ({
      title: item.title,
      url: item.url,
      source_name: item.source_name,
      source_type: item.source_type,
      published_date: item.published_date ?? "",
      freshness_label: item.published_date ? ("recent" as const) : ("unknown" as const),
      article_type: item.source_type === "sns" ? ("sns_trend" as const) : ("unknown" as const),
      reliability: item.source_type === "official" ? ("A" as const) : ("C" as const),
      key_points: item.key_points,
      angle_kind: item.angle_kind ?? inferRelatedAngleKind(item.query, item.title)
    }));

  const existingKeys = new Set(topic.evidence_articles.map((article) => article.url || `${article.source_name}:${article.title}`));
  // Only a fetched document with a usable date and matching claim may affect
  // the topic. Search snippets and failed pages stay visible in observations.
  const newEvidence = evidence
    .filter((item) => item.evidence_role !== "related_angle")
    .filter((item) => item.validation_status === "verified" && item.claim_coverage?.matched)
    .filter((item) => {
      const key = item.url || `${item.source_name}:${item.title}`;
      if (existingKeys.has(key)) {
        return false;
      }
      existingKeys.add(key);
      return true;
    })
    .map((item) => ({
      title: item.title,
      url: item.url,
      source_name: item.source_name,
      source_type: item.source_type,
      published_date: item.published_date ?? "",
      freshness_label: item.published_date ? ("recent" as const) : ("unknown" as const),
      article_type: item.source_type === "sns" ? ("sns_trend" as const) : ("unknown" as const),
      reliability: item.source_type === "official" ? ("A" as const) : ("C" as const),
      key_points: item.key_points,
      media_family: item.media_family || normalizeMediaFamily(item.url || item.source_name)
    }));

  if (!newEvidence.length) {
    return relatedEvidence.length
      ? { ...topic, related_evidence_articles: [...(topic.related_evidence_articles ?? []), ...relatedEvidence] }
      : topic;
  }

  const rootEvidence = [...topic.evidence_articles, ...newEvidence];
  const independentEvidence = getIndependentEvidence(rootEvidence);
  const sourceMix = { ...topic.source_mix };
  for (const item of newEvidence) {
    sourceMix[item.source_type] = (sourceMix[item.source_type] ?? 0) + 1;
  }

  return {
    ...topic,
    source_count: independentEvidence.length,
    source_mix: sourceMix,
    evidence_articles: [...topic.evidence_articles, ...newEvidence],
    related_evidence_articles: [...(topic.related_evidence_articles ?? []), ...relatedEvidence],
    signals: {
      ...topic.signals,
      has_data_signal: topic.signals.has_data_signal || newEvidence.some((item) => item.source_type === "data"),
      has_hot_search_signal: topic.signals.has_hot_search_signal || newEvidence.some((item) => item.source_type === "sns"),
      has_multiple_sources: independentEvidence.length > 1
    },
    selection_reason: `${topic.selection_reason}, expansion_evidence:${newEvidence.length}`
  };
}

function countIndependentEvidence(evidence: TopicCandidate["evidence_articles"]) {
  return getIndependentEvidence(evidence).length;
}

function toEvidence(item: RssItem, route: ExpansionRoute, routePath: string, query: string, lane: SourceResearchLane): SourceExpansionEvidence {
  const title = cleanText(item.title ?? "");
  const description = cleanText(item.contentSnippet ?? item.summary ?? stripHtml(item.content ?? ""));
  return {
    title,
    url: item.link ?? "",
    source_name: getHostname(item.link ?? "") || route.sourceName,
    source_type: getSerperSourceType(getHostname(item.link ?? "")) || route.sourceType,
    route_id: route.id,
    route: routePath,
    query,
    evidence_role: lane,
    ...(lane === "related_angle" ? { angle_kind: inferRelatedAngleKind(query, title) } : {}),
    key_points: [title, description].filter(Boolean).slice(0, 2),
    validation_status: "discovered",
    media_family: normalizeMediaFamily(item.link ?? "")
  };
}

function getTopicQueries(topic: TopicCandidate) {
  return rankTopicSearchQueries(topic);
}

function countRejectionReasons(
  assessed: Array<{ assessment: ReturnType<typeof assessSourceRelevance> }>,
  observations: SourceExpansionObservation[] = []
) {
  const counts: Record<string, number> = {};
  if (observations.length) {
    for (const observation of observations) {
      if (observation.status !== "rejected") continue;
      counts[observation.reason] = (counts[observation.reason] ?? 0) + 1;
    }
    return counts;
  }
  for (const { assessment } of assessed) {
    if (assessment.accepted) continue;
    const reason = assessment.reason;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function validateDiscoveries(
  topic: TopicCandidate,
  assessed: Array<{ item: SourceExpansionEvidence; assessment: ReturnType<typeof assessSourceRelevance> }>,
  query: string,
  lane: SourceResearchLane
) {
  const observations: SourceExpansionObservation[] = [];
  const accepted = assessed.filter(({ assessment }) => assessment.accepted);
  const candidates = accepted.slice(0, MAX_DOCUMENT_VALIDATIONS_PER_QUERY);
  for (const { item, assessment } of assessed) {
    if (assessment.accepted) continue;
    observations.push(toObservation(topic, item, "rejected", assessment.reason));
  }
  for (const { item } of accepted.slice(MAX_DOCUMENT_VALIDATIONS_PER_QUERY)) {
    observations.push(toObservation(topic, item, "discovered", "document_validation_limit"));
  }

  const settled = await Promise.all(candidates.map(({ item }) => validateDiscoveredEvidence(topic, item, query, lane)));
  for (const result of settled) observations.push(result.observation);
  return {
    evidence: settled.flatMap((result) => (result.evidence ? [result.evidence] : [])),
    observations
  };
}

async function validateDiscoveredEvidence(topic: TopicCandidate, item: SourceExpansionEvidence, query: string, lane: SourceResearchLane) {
  if (!isSafePublicationSourceUrl(item.url)) {
    return { observation: toObservation(topic, item, "rejected", "unsafe_url") };
  }
  try {
    const response = await fetch(item.url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase2/0.2)" },
      signal: AbortSignal.timeout(getTimeoutMs())
    });
    if (!response.ok) return { observation: toObservation(topic, item, "rejected", `document_http_${response.status}`) };
    if (!isSafePublicationSourceUrl(response.url)) return { observation: toObservation(topic, item, "rejected", "unsafe_redirect_url") };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|xml|text\//i.test(contentType)) return { observation: toObservation(topic, item, "rejected", "non_document_content_type") };
    const snapshot = extractDocumentSnapshot(await response.text(), item.title);
    const extractionDiagnostic = {
      document_extraction_method: snapshot.extraction_method,
      document_extraction_quality: snapshot.extraction_quality.status
    } as const;
    if (snapshot.extraction_quality.status === "unusable") return { observation: { ...toObservation(topic, item, "rejected", "document_text_unusable"), ...extractionDiagnostic } };
    if (snapshot.text.length < 80) return { observation: { ...toObservation(topic, item, "rejected", "document_text_too_short"), ...extractionDiagnostic } };
    if (!snapshot.published_date) return { observation: { ...toObservation(topic, item, "rejected", "missing_published_date"), ...extractionDiagnostic } };
    if (lane === "related_angle" && !isCurrentRelatedAngle(topic, snapshot.published_date)) {
      return { observation: { ...toObservation(topic, item, "rejected", "related_angle_outside_current_window", snapshot.published_date), ...extractionDiagnostic } };
    }
    const relevance = assessSourceRelevance(topic, { title: snapshot.title || item.title, url: response.url, key_points: [snapshot.text.slice(0, 2000)] }, query, lane);
    if (!relevance.accepted) return { observation: { ...toObservation(topic, item, "rejected", relevance.reason, snapshot.published_date), ...extractionDiagnostic } };
    const coverage = lane === "corroboration" ? assessClaimCoverage(topic, { title: snapshot.title || item.title, text: snapshot.text }) : undefined;
    if (coverage && !coverage.matched) return { observation: { ...toObservation(topic, item, "rejected", coverage.reason, snapshot.published_date, coverage), ...extractionDiagnostic } };
    const evidence: SourceExpansionEvidence = {
      ...item,
      title: snapshot.title || item.title,
      url: response.url,
      source_name: getHostname(response.url) || item.source_name,
      source_type: getSerperSourceType(getHostname(response.url)),
      key_points: [snapshot.title || item.title, snapshot.text.slice(0, 1000)].filter(Boolean),
      validation_status: "verified",
      validation_reason: lane === "corroboration" ? "document_verified" : "related_angle_document_verified",
      published_date: snapshot.published_date,
      media_family: normalizeMediaFamily(response.url),
      claim_coverage: coverage,
      document_text_length: snapshot.text.length,
      ...extractionDiagnostic,
      ...(lane === "related_angle" ? { angle_kind: inferRelatedAngleKind(query, snapshot.title || item.title) } : {})
    };
    return { evidence, observation: toObservation(topic, evidence, "accepted", evidence.validation_reason ?? "document_verified", snapshot.published_date, coverage) };
  } catch (error) {
    return { observation: toObservation(topic, item, "rejected", getFailureStage(error)) };
  }
}

export function isCurrentRelatedAngle(topic: TopicCandidate, publishedDate: string, maxAgeDays = 14) {
  const rootDate = topic.published_date_range.latest;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(rootDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(publishedDate)) return false;
  const delta = (Date.parse(`${rootDate}T00:00:00Z`) - Date.parse(`${publishedDate}T00:00:00Z`)) / 86_400_000;
  return delta >= -1 && delta <= maxAgeDays;
}

function toObservation(
  topic: TopicCandidate,
  item: SourceExpansionEvidence,
  status: SourceExpansionObservation["status"],
  reason: string,
  publishedDate?: string,
  claimCoverage?: SourceExpansionEvidence["claim_coverage"]
): SourceExpansionObservation {
  return {
    topic_key: topic.topic_key,
    query: item.query,
    route_id: item.route_id,
    evidence_role: item.evidence_role,
    url: item.url,
    title: item.title,
    source_name: item.source_name,
    media_family: item.media_family || normalizeMediaFamily(item.url || item.source_name),
    status,
    reason,
    ...(publishedDate ? { published_date: publishedDate } : {}),
    ...(claimCoverage ? { claim_coverage: claimCoverage } : {}),
    ...(item.document_extraction_method ? { document_extraction_method: item.document_extraction_method } : {}),
    ...(item.document_extraction_quality ? { document_extraction_quality: item.document_extraction_quality } : {})
  };
}

function uniqueTopics(topics: TopicCandidate[]) {
  return [...new Map(topics.map((topic) => [topic.topic_key, topic])).values()];
}

function buildResearchCandidates(topics: TopicCandidate[], options: SourceExpansionOptions): SourceResearchCandidate[] {
  const preferred = options.preferenceExploration ?? [];
  const candidates = uniqueTopics([...preferred, ...topics])
    .filter((topic) => ["today", "yesterday", "recent"].includes(topic.freshness_label))
    .sort((a, b) => b.newsworthiness_score - a.newsworthiness_score || a.topic_key.localeCompare(b.topic_key, "ja"))
    .slice(0, 3);
  return candidates.map((topic) => {
    const risk = classifyEvidenceRisk(topic);
    return {
      topic_key: topic.topic_key,
      title_hint: topic.title_hint,
      event_sentence: topic.event_sentence,
      risk_class: risk,
      required_independent_evidence: requiredIndependentEvidence(risk),
      reason: preferred.some((item) => item.topic_key === topic.topic_key)
        ? "preference_exploration"
        : options.emptyDay
          ? "empty_day_research"
          : "baseline_research"
    };
  });
}

function selectRelatedAngleTopics(topics: TopicCandidate[], options: SourceExpansionOptions) {
  const preferred = options.preferenceExploration ?? [];
  const singleFamily = topics.filter((topic) => countIndependentEvidence(topic.evidence_articles) <= 1);
  return uniqueTopics([...preferred, ...singleFamily])
    .filter((topic) => ["today", "yesterday", "recent"].includes(topic.freshness_label))
    .sort((left, right) => {
      const leftPreferred = preferred.some((topic) => topic.topic_key === left.topic_key) ? 1 : 0;
      const rightPreferred = preferred.some((topic) => topic.topic_key === right.topic_key) ? 1 : 0;
      return rightPreferred - leftPreferred || right.newsworthiness_score - left.newsworthiness_score || left.topic_key.localeCompare(right.topic_key, "ja");
    })
    .slice(0, getMaxRelatedAngleTopics());
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

function getMaxTopics(override?: number) {
  if (Number.isFinite(override)) return Math.max(1, Math.min(8, Math.floor(override!)));
  const value = Number(process.env.SOURCE_EXPANSION_MAX_TOPICS ?? DEFAULT_MAX_TOPICS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOPICS;
}

function getQueriesPerTopic() {
  const value = Number(process.env.SOURCE_EXPANSION_QUERIES_PER_TOPIC ?? DEFAULT_QUERIES_PER_TOPIC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUERIES_PER_TOPIC;
}

function getMaxRelatedAngleTopics() {
  const value = Number(process.env.SOURCE_EXPANSION_RELATED_ANGLE_MAX_TOPICS ?? DEFAULT_RELATED_ANGLE_TOPICS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RELATED_ANGLE_TOPICS;
}

function getRelatedAngleQueriesPerTopic(override?: number) {
  if (Number.isFinite(override)) return Math.max(1, Math.min(6, Math.floor(override!)));
  const value = Number(process.env.SOURCE_EXPANSION_RELATED_ANGLE_QUERIES_PER_TOPIC ?? DEFAULT_RELATED_ANGLE_QUERIES_PER_TOPIC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RELATED_ANGLE_QUERIES_PER_TOPIC;
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

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
