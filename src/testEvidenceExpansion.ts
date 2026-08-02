import assert from "node:assert/strict";
import { assessClaimCoverage, classifyEvidenceRisk, requiredIndependentEvidence } from "./evidence/claimCoverage.js";
import { extractDocumentSnapshot } from "./evidence/documentSnapshot.js";
import { normalizeMediaFamily } from "./evidence/mediaFamily.js";
import type { TopicCandidate } from "./types.js";

const delayTopic = topic({
  title_hint: "群星闪耀时撤档延期",
  event_sentence: "群星闪耀时の公開延期が発表された",
  search_queries: ["群星闪耀时 撤档 延期"]
});

assert.equal(classifyEvidenceRisk(delayTopic), "medium");
assert.equal(requiredIndependentEvidence("high"), 2);
assert.equal(normalizeMediaFamily("https://k.sina.com.cn/article/a"), "sina");
assert.equal(normalizeMediaFamily("https://ent.sina.com.cn/a"), "sina");

const unrelatedScreening = assessClaimCoverage(delayTopic, {
  title: "《群星闪耀时》特别放映活动举行",
  text: "该片此前举办特别放映，观众到场交流。"
});
assert.equal(unrelatedScreening.matched, false);
assert.equal(unrelatedScreening.reason, "different_claim_kind");

const sameDelay = assessClaimCoverage(delayTopic, {
  title: "《群星闪耀时》宣布撤档延期",
  text: "片方公告称将调整上映档期。"
});
assert.equal(sameDelay.matched, true);

const snapshot = extractDocumentSnapshot(`
  <html><head><meta property="article:published_time" content="2026-07-24T12:00:00+08:00"><title>测试文章</title></head>
  <body><article>这是一段足够长的正文内容，用于验证HTML正文和发布日期提取。</article></body></html>
`);
assert.equal(snapshot.published_date, "2026-07-24");
assert.match(snapshot.text, /验证HTML正文/);

console.log("evidence expansion checks passed");

function topic(overrides: Partial<TopicCandidate>): TopicCandidate {
  return {
    topic_key: "test",
    title_hint: "test",
    event_sentence: "",
    search_queries: [],
    seed_source: "regex_fallback",
    seed_confidence: 0,
    topic_type: "release",
    freshness_label: "today",
    published_date_range: { earliest: "", latest: "" },
    source_count: 1,
    source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [],
    main_entities: { people: [], works: [], organizations: [], events: [] },
    signals: { has_official_source: false, has_media_context: true, has_data_signal: false, has_hot_search_signal: false, has_multiple_sources: false },
    newsworthiness_score: 60,
    japan_gap: "unknown",
    context_value: "low",
    publish_priority: "medium",
    selection_reason: "test",
    caution_note: "",
    ...overrides
  };
}
