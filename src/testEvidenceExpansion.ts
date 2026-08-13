import assert from "node:assert/strict";
import { assessClaimCoverage, classifyEvidenceRisk, requiredIndependentEvidence } from "./evidence/claimCoverage.js";
import { extractDocumentSnapshot } from "./evidence/documentSnapshot.js";
import { normalizeMediaFamily } from "./evidence/mediaFamily.js";
import { attachExpansionEvidence, isCurrentRelatedAngle } from "./expandSources.js";
import { buildTopicCandidates } from "./topicCandidates.js";
import type { RawArticle, TopicCandidate } from "./types.js";

const delayTopic = topic({
  title_hint: "群星闪耀时撤档延期",
  event_sentence: "群星闪耀时の公開延期が発表された",
  search_queries: ["群星闪耀时 撤档 延期"]
});

assert.equal(classifyEvidenceRisk(delayTopic), "medium");
assert.equal(requiredIndependentEvidence("high"), 2);
assert.equal(normalizeMediaFamily("https://k.sina.com.cn/article/a"), "sina");
assert.equal(normalizeMediaFamily("https://ent.sina.com.cn/a"), "sina");

// 成毅の同一ミーム記事が新浪系の別URLに転載されても、独立した
// 二根拠にはならない。URL数ではなく媒体系列で数える回帰fixture。
const sinaCandidates = buildTopicCandidates([
  rawArticle("新浪娱乐", "https://ent.sina.com.cn/tv/2026-07-24/doc-chengyi.html"),
  rawArticle("新浪看点", "https://k.sina.com.cn/article_123456.html")
]);
const sinaTopic = sinaCandidates[0];
assert.ok(sinaTopic, "新浪系fixture creates one topic");
assert.equal(sinaTopic.source_count, 1, "新浪系2 URL are one independent media family");
assert.equal(sinaTopic.signals.has_multiple_sources, false, "syndication does not set the multi-source signal");
assert.deepEqual(sinaTopic.evidence_articles.map((item) => item.media_family), ["sina", "sina"], "root evidence retains the normalized family");

const sinaExpansion = attachExpansionEvidence(
  buildTopicCandidates([rawArticle("新浪娱乐", "https://ent.sina.com.cn/tv/2026-07-24/doc-chengyi.html")])[0]!,
  [{
    title: "成毅短劇ミームが話題に",
    url: "https://k.sina.com.cn/article_123456.html",
    source_name: "新浪看点",
    source_type: "media_report",
    route_id: "fixture",
    route: "fixture",
    query: "成毅 短劇 ミーム",
    validation_status: "verified",
    claim_coverage: { target_claim: "成毅の短劇ミームが話題", observed_claim: "成毅の短劇ミームが話題", matched: true, reason: "fixture" },
    key_points: ["成毅短劇ミームが話題"],
    media_family: "sina"
  }]
);
assert.equal(sinaExpansion.source_count, 1, "expansion also keeps same-family reposts out of source_count");
assert.equal(sinaExpansion.signals.has_multiple_sources, false, "expansion does not inflate EVS corroboration");

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
assert.equal(isCurrentRelatedAngle({ ...delayTopic, published_date_range: { earliest: "2026-08-13", latest: "2026-08-13" } }, "2026-08-12"), true);
assert.equal(isCurrentRelatedAngle({ ...delayTopic, published_date_range: { earliest: "2026-08-13", latest: "2026-08-13" } }, "2023-08-18"), false, "old reactions cannot be attached as reception of a current interview");

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

function rawArticle(sourceName: string, url: string): RawArticle {
  return {
    title: "成毅の短劇ミーム、ファンの間で話題に",
    url,
    sourceName,
    sourceUrl: url,
    category: "entertainment",
    reliability: "B",
    sourceType: "media_report",
    publishedDate: "2026-07-24",
    freshnessLabel: "today",
    articleType: "sns_trend",
    topicKey: "成毅短劇ミーム",
    excerpt: "成毅の短劇ミームがファンの間で話題になっている。",
    newsworthinessScore: 72
  };
}
