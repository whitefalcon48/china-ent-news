import assert from "node:assert/strict";
import { runClaimCheck } from "./claimCheck.js";
import { attachExpansionEvidence } from "./expandSources.js";
import { normalizeFactLedger } from "./factLedger.js";
import { formatEvidenceForPrompt, mergeTopicInternalMetadata } from "./summarizeWithGemini.js";
import type { FactLedger, RawArticle, SourceExpansionEvidence, SummarizedArticle, TopicCandidate } from "./types.js";

const rootEvidence = [
  evidence("界面新闻", "谢贤逝世，香港影坛演员谢贤去世", "https://example.com/jm", "corroboration"),
  evidence("新京报", "演员谢贤逝世", "https://example.com/bj", "corroboration")
];
const nicholasAngle = evidence("港媒", "谢霆锋回应父亲谢贤离世", "https://example.com/nicholas", "related_angle", "谢贤 谢霆锋 回应");

const xieXianTopic = {
  topic_key: "谢贤逝世",
  title_hint: "谢贤逝世",
  event_sentence: "谢贤逝世が報じられた",
  search_queries: ["谢贤 逝世"],
  seed_source: "llm",
  seed_confidence: 0.9,
  topic_type: "unknown",
  freshness_label: "today",
  published_date_range: { earliest: "2026-08-01", latest: "2026-08-01" },
  source_count: 2,
  source_mix: { official: 0, media_report: 2, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
  evidence_articles: rootEvidence.map(toTopicEvidence),
  main_entities: { people: ["谢贤", "谢霆锋"], works: [], organizations: [], events: ["谢贤逝世"] },
  signals: { has_official_source: false, has_media_context: true, has_data_signal: false, has_hot_search_signal: false, has_multiple_sources: true },
  newsworthiness_score: 80,
  japan_gap: "high",
  context_value: "high",
  publish_priority: "high",
  selection_reason: "fixture",
  caution_note: ""
} satisfies TopicCandidate;

const expanded = attachExpansionEvidence(xieXianTopic, [nicholasAngle]);
assert.equal(expanded.related_evidence_articles?.length, 1, "谢霆锋の発言は検証済み関連角度として保存する");
assert.equal(expanded.related_evidence_articles?.[0]?.angle_kind, "person_response");
assert.equal(expanded.source_count, xieXianTopic.source_count, "related angle never changes root source_count");
assert.deepEqual(expanded.source_mix, xieXianTopic.source_mix, "related angle never changes root source_mix");
assert.deepEqual(expanded.signals, xieXianTopic.signals, "related angle never changes root signals");
assert.equal(expanded.selection_reason, xieXianTopic.selection_reason, "related-only attach never changes selection trace reason");

const promptEvidence: RawArticle[] = [
  ...expanded.evidence_articles.map((item) => restore(item, "root_corroboration")),
  ...(expanded.related_evidence_articles ?? []).map((item) => restore(item, "related_angle"))
];
const evidencePrompt = formatEvidenceForPrompt(promptEvidence);
assert.match(evidencePrompt, /role: root_corroboration/);
assert.match(evidencePrompt, /role: related_angle \/ angle_kind: person_response/);

const ledger = normalizeFactLedger({
  claims: [
    { id: "C1", type: "verified_fact", scope: "root_event", text: "謝賢さんの死去が報じられた。", evidence_refs: ["E1", "E2"], entities: ["谢贤"], numbers: [], quote_zh: "谢贤去世" },
    { id: "C2", type: "verified_fact", scope: "related_angle", angle_kind: "person_response", text: "謝霆鋒さんが父の死去に言及した。", evidence_refs: ["E3"], entities: ["谢霆锋"], numbers: [], quote_zh: "谢霆锋回应" }
  ],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
}, xieXianTopic.topic_key, promptEvidence.map((item) => `${item.title}\n${item.rawContent}`).join("\n"), undefined, {
  E1: "root_corroboration",
  E2: "root_corroboration",
  E3: "related_angle"
});
const rootScopeCannotBeOverridden = normalizeFactLedger({
  claims: [{ id: "C-root", type: "verified_fact", scope: "related_angle", text: "中心記事の事実。", evidence_refs: ["E1"], entities: [], numbers: [], quote_zh: "谢贤去世" }],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
}, xieXianTopic.topic_key, promptEvidence.map((item) => `${item.title}\n${item.rawContent}`).join("\n"), undefined, { E1: "root_corroboration" });
assert.equal(rootScopeCannotBeOverridden.claims[0]?.scope, "root_event", "a model label cannot turn root evidence into a related angle");
assert.equal(ledger.claims[0]?.scope, "root_event");
assert.equal(ledger.claims[1]?.scope, "related_angle");
assert.equal(runClaimCheck(summaryFor(ledger), ledger).gated_violation_count, 0, "root and related claims can coexist when their evidence scopes are separate");

const sourceSplit = mergeTopicInternalMetadata({
  ...summaryFor(ledger),
  source_list: [
    { name: "界面新闻", url: "https://example.com/jm" },
    { name: "港媒", url: "https://example.com/nicholas" }
  ],
  related_sources: [{ name: "港媒", url: "https://example.com/nicholas" }]
}, expanded, promptEvidence);
assert.deepEqual(sourceSplit.source_list, [{ name: "界面新闻", url: "https://example.com/jm" }], "source_list retains root evidence only");
assert.deepEqual(sourceSplit.related_sources, [{ name: "港媒", url: "https://example.com/nicholas" }], "related_sources retains only the used related angle");
assert.equal(sourceSplit.source_count, 1, "summary source_count does not count related evidence");
assert.equal(sourceSplit.has_multiple_sources, false, "summary has_multiple_sources does not count related evidence");

const invalidRootLedger: FactLedger = {
  ...ledger,
  claims: [{ ...ledger.claims[0]!, evidence_refs: ["E3"], scope: "root_event" }]
};
assert.ok(
  runClaimCheck(summaryFor(invalidRootLedger), invalidRootLedger).violations.some((item) => item.rule === "root_claim_uses_related_evidence" && item.severity === "gate"),
  "a related angle alone cannot corroborate the root event"
);

const kungFuTopic = { ...xieXianTopic, topic_key: "功夫女足上映", title_hint: "功夫女足上映", event_sentence: "『功夫女足』が上映された", main_entities: { people: [], works: ["功夫女足"], organizations: [], events: ["功夫女足上映"] } };
const kungFuExpanded = attachExpansionEvidence(kungFuTopic, [evidence("票房媒体", "《功夫女足》票房が話題に", "https://example.com/kungfu", "related_angle", "功夫女足 票房")]);
assert.equal(kungFuExpanded.source_count, kungFuTopic.source_count, "功夫女足の票房角度も上映根拠の数に加えない");
assert.equal(kungFuExpanded.related_evidence_articles?.[0]?.angle_kind, "work_context");

console.log("related evidence pipeline tests passed");

function evidence(source: string, title: string, url: string, role: "corroboration" | "related_angle", query = "谢贤 逝世") : SourceExpansionEvidence {
  return {
    title,
    url,
    source_name: source,
    source_type: "media_report",
    route_id: "fixture",
    route: "fixture",
    query,
    evidence_role: role,
    key_points: [title, title],
    validation_status: "verified",
    published_date: "2026-08-01"
  };
}

function toTopicEvidence(item: SourceExpansionEvidence) {
  return {
    title: item.title,
    url: item.url,
    source_name: item.source_name,
    source_type: item.source_type,
    published_date: item.published_date ?? "",
    freshness_label: "today" as const,
    article_type: "news_event" as const,
    reliability: "B" as const,
    key_points: item.key_points
  };
}

function restore(item: TopicCandidate["evidence_articles"][number] | NonNullable<TopicCandidate["related_evidence_articles"]>[number], role: "root_corroboration" | "related_angle"): RawArticle {
  return {
    title: item.title,
    url: item.url,
    sourceName: item.source_name,
    sourceUrl: item.url,
    category: "fixture",
    reliability: item.reliability,
    sourceType: item.source_type,
    publishedDate: item.published_date,
    freshnessLabel: item.freshness_label,
    articleType: item.article_type,
    rawContent: item.key_points.join("\n"),
    evidenceRole: role,
    ...(role === "related_angle" ? { angleKind: (item as NonNullable<TopicCandidate["related_evidence_articles"]>[number]).angle_kind } : {})
  };
}

function summaryFor(ledger: FactLedger): SummarizedArticle {
  return {
    title_ja: "テスト", badge: "NEWS", lead: "", what_happened: "", why_it_matters: "", reaction_view: "", editor_comment: "", japan_context_note: "",
    category: "", confidence: "B", source_type: "media_report", published_date: "", event_date: "", freshness_label: "today", newsworthiness_score: 0,
    japan_visibility: "unknown", japan_gap: "unknown", context_value: "low", sns_heat: "none", source_count: 2, source_list: [], has_official_source: false,
    has_multiple_sources: true, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "", topic_key: ledger.topic_key,
    main_entities: { people: [], works: [], organizations: [] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "",
    claim_refs: { what_happened: ["C1"], why_it_matters: ["C2"], reaction_view: [], japan_context_note: [] }
  };
}
