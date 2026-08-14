import type { ClaimCoverage, EvidenceRiskClass, TopicCandidate } from "../types.js";

type ClaimKind = "obituary" | "direct_statement" | "private_life" | "release_delay" | "screening" | "ai_event" | "stage_or_festival" | "general";

export function classifyEvidenceRisk(topic: Pick<TopicCandidate, "title_hint" | "event_sentence" | "search_queries">): EvidenceRiskClass {
  const kind = claimKind(topicText(topic));
  if (["obituary", "direct_statement", "private_life"].includes(kind)) return "high";
  if (["release_delay", "ai_event"].includes(kind)) return "medium";
  return "low";
}

export function requiredIndependentEvidence(risk: EvidenceRiskClass) {
  return risk === "high" ? 2 : 1;
}

/**
 * A shared title is not enough.  For example, a past special screening and a
 * new postponement of the same work have different claim kinds and cannot be
 * counted as support for each other.
 */
export function assessClaimCoverage(
  topic: Pick<TopicCandidate, "title_hint" | "event_sentence" | "search_queries">,
  document: { title: string; text: string }
): ClaimCoverage {
  const target = claimKind(topicText(topic));
  const observed = claimKind(`${document.title} ${document.text}`);
  const targetTerms = importantTerms(topicText(topic));
  const documentText = normalize(`${document.title} ${document.text}`);
  const entityMatched = targetTerms.some((term) => documentText.includes(term));

  const numericAggregate = assessNumericAggregateCoverage(`${topic.title_hint} ${topic.event_sentence}`, `${document.title} ${document.text}`);
  if (numericAggregate && !numericAggregate.matched) {
    return { target_claim: target, observed_claim: observed, matched: false, reason: numericAggregate.reason };
  }
  if (numericAggregate?.matched) {
    return { target_claim: target, observed_claim: observed, matched: true, reason: numericAggregate.reason };
  }

  if (!entityMatched) {
    return { target_claim: target, observed_claim: observed, matched: false, reason: "topic_entity_not_found_in_document" };
  }
  if (target !== "general" && observed !== target) {
    return { target_claim: target, observed_claim: observed, matched: false, reason: "different_claim_kind" };
  }
  return { target_claim: target, observed_claim: observed, matched: true, reason: target === "general" ? "entity_and_query_match" : "same_claim_kind" };
}

function assessNumericAggregateCoverage(targetText: string, observedText: string) {
  if (!/票房/u.test(targetText) || !/(?:暑期档|春节档|国庆档|电影市场)/u.test(targetText)) return null;
  const centralNumbers = targetText.match(/\d+(?:\.\d+)?(?:亿元|万元|亿|万|元)/gu) ?? [];
  if (!centralNumbers.length) return null;
  const observedNumbers = new Set((observedText.match(/\d+(?:\.\d+)?(?:亿元|万元|亿|万|元)/gu) ?? []).map(normalizeAggregateNumber));
  if (!centralNumbers.some((number) => observedNumbers.has(normalizeAggregateNumber(number)))) {
    return { matched: false, reason: "central_number_not_found" };
  }
  const eventMatched = /(暑期档|春节档|国庆档|电影市场)/u.exec(targetText)?.[1];
  if (!eventMatched || !observedText.includes(eventMatched)) return { matched: false, reason: "event_anchor_not_found" };
  const targetYear = /20\d{2}/u.exec(targetText)?.[0];
  if (targetYear && !observedText.includes(targetYear)) return { matched: false, reason: "event_anchor_not_found" };
  if (!/票房/u.test(observedText)) return { matched: false, reason: "metric_anchor_not_found" };
  return { matched: true, reason: "numeric_aggregate_match" };
}

function normalizeAggregateNumber(value: string) {
  return value.replace(/亿元$/u, "亿").replace(/万元$/u, "万");
}

function claimKind(value: string): ClaimKind {
  if (/讣告|逝世|去世|离世|病逝|逝去/.test(value)) return "obituary";
  if (/离婚|共同育儿|抚养|复婚|恋情|出轨|私生活/.test(value)) return "private_life";
  if (/延期|撤档|改档|延后|推迟/.test(value)) return "release_delay";
  if (/点映|特别放映|展映|上映|公映/.test(value)) return "screening";
  if (/人工智能|AI|视听|广电|网络视听|创新大赛|创新大会/.test(value)) return "ai_event";
  if (/舞台|剧场|演出|电影节|影展|文化节/.test(value)) return "stage_or_festival";
  if (/回应|发声|称|表示|说|谈及|透露/.test(value)) return "direct_statement";
  return "general";
}

function topicText(topic: Pick<TopicCandidate, "title_hint" | "event_sentence" | "search_queries">) {
  return `${topic.title_hint} ${topic.event_sentence} ${topic.search_queries.join(" ")}`;
}

function importantTerms(value: string) {
  const quoted = [...value.matchAll(/[《「](.+?)[》」]/g)].map((match) => match[1] ?? "");
  const queryEntities = value
    .split(/[\s,，、。；;|]+/)
    .map((part) => part.replace(/延期|撤档|改档|点映|展映|上映|讣告|逝世|去世|离世|共同育儿|离婚|人工智能|创新大赛/g, ""));
  const beforeClaimMarker = [...value.matchAll(/([\p{Script=Han}]{2,}?)(?:延期|撤档|改档|点映|展映|上映|讣告|逝世|去世|离世|共同育儿|离婚|人工智能|创新大赛)/gu)]
    .map((match) => match[1] ?? "");
  return [...new Set([...quoted, ...queryEntities, ...beforeClaimMarker, ...(value.match(/[\p{Script=Han}]{2,}/gu) ?? [])])]
    .map(normalize)
    .filter((term) => term.length >= 2 && term.length <= 24)
    .filter((term) => !/^(电影|舞台|中国|正式|作品|相关|举行|发布|大会|新闻)$/.test(term))
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, "");
}
