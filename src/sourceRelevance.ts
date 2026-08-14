import type { RelatedAngleKind, TopicCandidate } from "./types.js";

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
  { test: /听力下降|失聪|听不见|聴力低下|聞こえない/, match: /听力下降|听力受损|失聪|听不见|耳聋|聴力低下|聞こえない/ },
  { test: /短剧演员/, match: /短剧|微短剧/ }
];

export type SourceRelevanceReason =
  | "accepted_title_match"
  | "accepted_query_match"
  | "accepted_fact_anchor_match"
  | "accepted_related_entity_and_angle"
  | "missing_title_or_url"
  | "unsafe_url"
  | "weak_topic_match"
  | "related_missing_canonical_entity"
  | "related_missing_angle";

export type SourceResearchLane = "corroboration" | "related_angle";

export function assessSourceRelevance(
  topic: TopicCandidate,
  evidence: EvidenceLike,
  query?: string,
  lane: SourceResearchLane = "corroboration"
): { accepted: boolean; reason: SourceRelevanceReason } {
  if (!evidence.title.trim() || !evidence.url.trim()) return { accepted: false, reason: "missing_title_or_url" };
  if (!isSafePublicationSourceUrl(evidence.url)) return { accepted: false, reason: "unsafe_url" };

  if (lane === "related_angle") {
    return assessRelatedAngleRelevance(topic, evidence, query);
  }
  if (hasStrongTitleMatch(topic.title_hint, evidence.title)) return { accepted: true, reason: "accepted_title_match" };

  const queries = query ? [query] : rankTopicSearchQueries(topic);
  const text = normalizeText(`${evidence.title} ${evidence.key_points.join(" ")}`);
  if (queries.some((candidate) => matchesFactAnchorQuery(candidate, text))) {
    return { accepted: true, reason: "accepted_fact_anchor_match" };
  }
  if (queries.some((candidate) => matchesNormalizedQuery(candidate, text) || matchesSpecificQuery(topic, candidate, text))) {
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

/**
 * Builds bounded, discovery-only queries for another angle on the same person
 * or work. These queries are deliberately kept separate from corroboration:
 * their results can never make a factual claim multi-source.
 */
export function rankRelatedAngleSearchQueries(topic: TopicCandidate) {
  const entityCandidates = isObituaryRoot(topic) || isPersonInterviewTopic(topic)
    ? [...topic.main_entities.people, ...topic.main_entities.works]
    : [...topic.main_entities.works, ...topic.main_entities.people, ...topic.main_entities.events];
  const entities = entityCandidates
    .map((value) => value.trim())
    .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index)
    .slice(0, 2);
  const angles = relatedAngleTerms(topic);
  const interviewContext = isPersonInterviewTopic(topic) ? personInterviewContext(topic) : "";
  const unique = new Map<string, string>();
  for (const entity of entities) {
    for (const angle of angles) {
      const query = [entity, interviewContext, angle].filter(Boolean).join(" ");
      const normalized = normalizeText(query);
      if (!unique.has(normalized)) unique.set(normalized, query);
    }
  }
  return [...unique.values()];
}

/**
 * This label describes the supplementary document itself.  It must not be
 * used as a proxy for corroboration of the root event.
 */
export function inferRelatedAngleKind(query: string, title = ""): RelatedAngleKind {
  const text = normalizeText(`${query} ${title}`);
  if (/回应|发声|悼念|追忆|回忆|谈及|称|表示/.test(text)) return "person_response";
  if (/生涯|从影|代表作|回顾|影史|评价/.test(text)) return "career_retrospective";
  if (/粉丝|热议|争议|口碑|热搜|讨论/.test(text)) return "audience_reaction";
  if (/票房|幕后|上映|公映|点映|制作|作品/.test(text)) return "work_context";
  return "other";
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
  // A person plus a distinctive condition/event (for example
  // "李雪健 听力下降") is already specific. Generic occupation queries such
  // as "王年将成 短剧演员" still need another event term.
  if (entityMatches >= 1 && contextMatches >= 1) {
    const contextTerms = terms.filter((term) => !isEntityTerm(term, entityTerms));
    if (contextTerms.some((term) => !GENERIC_QUERY_TERMS.has(term))) return true;
  }
  return entityMatches === 0 && contextMatches >= 2;
}

function personInterviewContext(topic: TopicCandidate) {
  const text = `${topic.topic_key} ${topic.title_hint} ${topic.event_sentence}`;
  if (/听力|失聪|听不见|聴力|聞こえない/.test(text)) return "听力";
  if (/抗癌|癌|がん/.test(text)) return "抗癌";
  if (/病情|近况|近況/.test(text)) return "近况";
  return "";
}

function assessRelatedAngleRelevance(topic: TopicCandidate, evidence: EvidenceLike, query?: string) {
  const text = normalizeEventAnchor(normalizeText(`${evidence.title} ${evidence.key_points.join(" ")}`));
  const canonicalEntities = [...topic.main_entities.people, ...topic.main_entities.works, ...topic.main_entities.events]
    .map((value) => normalizeEventAnchor(normalizeText(value)))
    .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
  if (!canonicalEntities.length || !canonicalEntities.some((entity) => text.includes(entity))) {
    return { accepted: false, reason: "related_missing_canonical_entity" as const };
  }
  const angleTerms = query ? splitQuery(query).filter((term) => !isEntityTerm(term, canonicalEntities)) : relatedAngleTerms(topic).map(normalizeText);
  if (!angleTerms.some((term) => matchesTerm(text, term))) {
    return { accepted: false, reason: "related_missing_angle" as const };
  }
  if (!matchesRootEventContext(topic, text)) {
    return { accepted: false, reason: "weak_topic_match" as const };
  }
  return { accepted: true, reason: "accepted_related_entity_and_angle" as const };
}

function matchesRootEventContext(topic: TopicCandidate, text: string) {
  if (topic.topic_type === "box_office") {
    const eventMatched = topic.main_entities.events
      .map((value) => normalizeEventAnchor(normalizeText(value)))
      .some((event) => event.length >= 4 && normalizeEventAnchor(text).includes(event));
    if (eventMatched && /票房/u.test(text)) return true;
  }
  const rootTerms = [topic.topic_key, topic.title_hint, topic.event_sentence, ...(topic.search_queries ?? [])]
    .filter((value): value is string => typeof value === "string")
    .flatMap(splitQuery)
    .filter((term) => !isEntityTerm(term, getEntityTokens(topic)))
    .filter((term) => !RELATED_EVENT_TERMS.has(term))
    .filter((term) => !RELATED_GENERIC_TERMS.has(term));
  if (!rootTerms.length) return true;
  return rootTerms.some((term) => matchesTerm(text, term));
}

function relatedAngleTerms(topic: TopicCandidate) {
  const candidates = topic.search_queries.flatMap(splitQuery)
    .filter((term) => !isEntityTerm(term, getEntityTokens(topic)))
    .filter((term) => !RELATED_EVENT_TERMS.has(term))
    .filter((term) => !RELATED_GENERIC_TERMS.has(term));
  const defaults = isObituaryRoot(topic)
    ? ["回应", "生涯", "悼念", "回顾"]
    : isPersonInterviewTopic(topic)
      ? ["热搜", "热议", "回应", "讨论"]
    : topic.topic_type === "box_office"
      ? ["热搜", "热议", "观众讨论"]
    : topic.main_entities.works.length
      ? ["口碑", "票房", "幕后", "争议"]
      : ["作品", "粉丝", "回应", "动态"];
  return [...new Set([...defaults, ...candidates])].slice(0, 4);
}

function isPersonInterviewTopic(topic: TopicCandidate) {
  return topic.main_entities.people.length > 0 && (
    (topic.evidence_articles ?? []).some((article) => article.article_type === "interview") ||
    /采访|专访|听力|抗癌|病情|近况|自述/.test(`${topic.title_hint} ${topic.event_sentence}`)
  );
}

function isObituaryRoot(topic: Pick<TopicCandidate, "topic_key" | "title_hint" | "event_sentence">) {
  return /逝世|去世|离世|讣告|病逝|死去|死亡/.test(`${topic.topic_key} ${topic.title_hint} ${topic.event_sentence}`);
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
    ...topic.main_entities.organizations,
    ...topic.main_entities.events
  ].map(normalizeText).filter((term) => term.length >= 2);
}

function isEntityTerm(term: string, entities: string[]) {
  const normalizedTerm = normalizeEventAnchor(term);
  return entities.some((entity) => {
    const normalizedEntity = normalizeEventAnchor(entity);
    return normalizedEntity === normalizedTerm || normalizedEntity.includes(normalizedTerm) || normalizedTerm.includes(normalizedEntity);
  });
}

function matchesTerm(text: string, term: string) {
  if (normalizeEventAnchor(text).includes(normalizeEventAnchor(term))) return true;
  return TERM_GROUPS.some((group) => group.test.test(term) && group.match.test(text));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu, "");
}

function normalizeEventAnchor(value: string) {
  return value.replace(/(20\d{2})年(?=暑期档|春节档|国庆档)/gu, "$1");
}

function normalizeComparableText(value: string) {
  return normalizeText(value)
    .replace(/(?:突破|超过)/gu, "超")
    .replace(/电影(?=票房)/gu, "");
}

/**
 * Chinese search queries are commonly written without spaces.  Treating the
 * entire query as a single token previously made every such query fail the
 * `terms.length < 2` guard before full-page validation.  This is discovery
 * only: accepted candidates still have to pass document and claim coverage.
 */
function matchesNormalizedQuery(query: string, normalizedText: string) {
  const normalizedQuery = normalizeComparableText(query);
  if (normalizedQuery.length < 8) return false;
  return normalizeComparableText(normalizedText).includes(normalizedQuery);
}

function matchesFactAnchorQuery(query: string, normalizedText: string) {
  const comparableQuery = normalizeComparableText(query);
  const comparableText = normalizeComparableText(normalizedText);
  const centralNumbers = comparableQuery.match(/\d+(?:\.\d+)?(?:亿|万|元|部|天|日|%)/gu) ?? [];
  const observedNumbers = new Set((comparableText.match(/\d+(?:\.\d+)?(?:亿|万|元|部|天|日|%)/gu) ?? []).map(normalizeAmount));
  if (!centralNumbers.length || !centralNumbers.some((anchor) => observedNumbers.has(normalizeAmount(anchor)))) return false;
  const contextMatched = /暑期档|春节档|国庆档|电影市场/u.test(comparableQuery)
    && /暑期档|春节档|国庆档|电影市场/u.test(comparableText);
  const metricMatched = /票房|观影人次|场次|平均票价/u.test(comparableQuery)
    && /票房|观影人次|场次|平均票价/u.test(comparableText);
  return contextMatched && metricMatched;
}

function normalizeAmount(value: string) {
  return value.replace(/亿元$/u, "亿").replace(/万元$/u, "万");
}

const RELATED_EVENT_TERMS = new Set([
  "撤档", "延期", "改档", "延后", "推迟", "逝世", "去世", "离世", "讣告", "上映", "公映", "点映", "展映", "宣布", "发布", "官宣"
].map(normalizeText));

const RELATED_GENERIC_TERMS = new Set(["电影", "影视", "短剧", "新闻", "作品", "演员"].map(normalizeText));
const GENERIC_QUERY_TERMS = new Set(["电影", "影视", "短剧", "短剧演员", "新闻", "作品", "演员", "娱乐", "动态", "经历"].map(normalizeText));

function hasStrongTitleMatch(left: string, right: string) {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 8) return false;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
}
