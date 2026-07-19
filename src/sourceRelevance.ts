import type { TopicCandidate } from "./types.js";

type EvidenceLike = {
  title: string;
  url: string;
  key_points: string[];
};

const BLOCKED_HOSTS = new Set([
  "rsvp-rentals.com"
]);

const TERM_GROUPS: Array<{ test: RegExp; match: RegExp }> = [
  { test: /转型|转行|改行|転身/, match: /转型|转行|改行|跨界|转战|転身|フィールドが変わ/ },
  { test: /足球运动员|サッカー選手/, match: /足球|中超|门将|球员|サッカー/ },
  { test: /联合|共同|合作/, match: /联合|共同|联手|合作|携手/ },
  { test: /发布|発表|推出/, match: /发布|発表|推出|上线|官宣|宣布|揭晓/ },
  { test: /短剧演员/, match: /短剧|微短剧/ }
];

export type SourceRelevanceReason =
  | "accepted_title_match"
  | "accepted_query_match"
  | "missing_title_or_url"
  | "unsafe_url"
  | "weak_topic_match";

export function assessSourceRelevance(topic: TopicCandidate, evidence: EvidenceLike, query?: string): { accepted: boolean; reason: SourceRelevanceReason } {
  if (!evidence.title.trim() || !evidence.url.trim()) return { accepted: false, reason: "missing_title_or_url" };
  if (!isSafePublicationSourceUrl(evidence.url)) return { accepted: false, reason: "unsafe_url" };
  if (hasStrongTitleMatch(topic.title_hint, evidence.title)) return { accepted: true, reason: "accepted_title_match" };

  const queries = query ? [query] : rankTopicSearchQueries(topic);
  const text = normalizeText(`${evidence.title} ${evidence.key_points.join(" ")}`);
  if (queries.some((candidate) => matchesSpecificQuery(topic, candidate, text))) {
    return { accepted: true, reason: "accepted_query_match" };
  }
  return { accepted: false, reason: "weak_topic_match" };
}

export function isRelevantEvidenceForTopic(topic: TopicCandidate, evidence: EvidenceLike) {
  return assessSourceRelevance(topic, evidence).accepted;
}

export function isSafePublicationSourceUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = normalizeHostname(url.hostname);
    if ([...BLOCKED_HOSTS].some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) return false;
    if (/^(?:www\.)?(?:google\.|bing\.com$|baidu\.com$)/.test(url.hostname.toLowerCase())) return false;
    if (/\/(?:search|s)(?:\/|$)/i.test(url.pathname)) return false;
    if (hostname === "youtube.com" && url.pathname === "/playlist") return false;
    return true;
  } catch {
    return false;
  }
}

export function rankTopicSearchQueries(topic: TopicCandidate) {
  const topicKey = normalizeText(topic.topic_key);
  const unique = new Map<string, string>();
  for (const raw of topic.search_queries) {
    const query = raw.trim();
    const normalized = normalizeText(query);
    if (!normalized || normalized === topicKey || unique.has(normalized)) continue;
    unique.set(normalized, query);
  }
  const ranked = [...unique.values()].sort((left, right) => querySpecificity(topic, right) - querySpecificity(topic, left));
  return ranked.length ? ranked : [topic.topic_key].filter(Boolean);
}

export function normalizeSourceHostname(value: string) {
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    return "";
  }
}

function querySpecificity(topic: TopicCandidate, query: string) {
  const terms = splitQuery(query);
  const entityTerms = getEntityTokens(topic);
  const contextCount = terms.filter((term) => !isEntityTerm(term, entityTerms)).length;
  return terms.length * 100 + contextCount * 30 + normalizeText(query).length;
}

function matchesSpecificQuery(topic: TopicCandidate, query: string, normalizedText: string) {
  const terms = splitQuery(query);
  if (terms.length < 2) return false;
  const entityTerms = getEntityTokens(topic);
  let entityMatches = 0;
  let contextMatches = 0;

  for (const term of terms) {
    if (!matchesTerm(normalizedText, term)) continue;
    if (isEntityTerm(term, entityTerms)) entityMatches += 1;
    else contextMatches += 1;
  }

  if (entityMatches >= 2 && contextMatches >= 1) return true;
  if (entityMatches >= 1 && contextMatches >= 2) return true;
  return entityMatches === 0 && contextMatches >= 2;
}

function splitQuery(query: string) {
  return query
    .split(/[\s,，、/|]+/)
    .map(normalizeText)
    .filter((term) => term.length >= 2);
}

function getEntityTokens(topic: TopicCandidate) {
  return [
    ...topic.main_entities.people,
    ...topic.main_entities.works,
    ...topic.main_entities.organizations
  ].map(normalizeText).filter((term) => term.length >= 2);
}

function isEntityTerm(term: string, entities: string[]) {
  return entities.some((entity) => entity === term || entity.includes(term) || term.includes(entity));
}

function matchesTerm(text: string, term: string) {
  if (text.includes(term)) return true;
  return TERM_GROUPS.some((group) => group.test.test(term) && group.match.test(text));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu, "");
}

function hasStrongTitleMatch(left: string, right: string) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 8) return false;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
}
