import type { TopicCandidate } from "./types.js";

export function evaluateTopicInformationCompleteness(topic: TopicCandidate): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const sourceNames = new Set(topic.evidence_articles.map((item) => item.source_name));
  const subjectOrganizations = topic.main_entities.organizations.filter((name) => !sourceNames.has(name));
  if (!topic.main_entities.people.length && !topic.main_entities.works.length && !topic.main_entities.events.length && !subjectOrganizations.length) reasons.push("no_subject_entity");
  if (topic.seed_source === "llm") {
    if (topic.seed_confidence < 0.5) reasons.push("low_seed_confidence");
    if (!topic.event_sentence.trim() || /という記事を掲載/.test(topic.event_sentence) || (topic.source_count === 1 && topic.title_hint && topic.event_sentence.includes(topic.title_hint))) reasons.push("title_echo_event");
    const keyPointLength = topic.evidence_articles.flatMap((item) => item.key_points).join("").length;
    if (topic.topic_type === "unknown" && topic.source_count === 1 && keyPointLength < 40) reasons.push("thin_unknown");
  }
  return { complete: reasons.length === 0, reasons };
}
