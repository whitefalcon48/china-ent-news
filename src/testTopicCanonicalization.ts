import assert from "node:assert/strict";
import { createTopicKey, getCanonicalTopicKey } from "./topicKey.js";
import { buildTopicCandidates } from "./topicCandidates.js";
import type { RawArticle, TopicSeed } from "./types.js";

const obituaryArticles = [
  article("https://jm.example.test/a", "谢贤逝世，香港影坛失去一位重要演员", "界面新闻"),
  article("https://bj.example.test/b", "谢贤去世，享年八十九岁", "新京报")
];

const obituarySeeds: TopicSeed[] = [
  seed(obituaryArticles[0]!, "谢贤逝世"),
  seed(obituaryArticles[1]!, "谢贤去世")
];

assert.equal(getCanonicalTopicKey({ topicKey: "谢贤去世", title: obituaryArticles[1]!.title, people: ["谢贤"] }), "谢贤逝世");
assert.equal(createTopicKey("香港老牌影星谢贤去世，享年八十九岁"), "谢贤逝世", "役職接頭辞付きでもregex fallbackは人物を含むroot keyに正規化する");

const grouped = buildTopicCandidates(obituaryArticles, obituarySeeds);
assert.equal(grouped.length, 1, "逝世/去世の同義表記は同一root eventに束ねる");
assert.equal(grouped[0]?.topic_key, "谢贤逝世");
assert.equal(grouped[0]?.source_count, 2);

const followUp = article("https://ent.example.test/c", "谢霆锋回应父亲谢贤逝世后的安排", "娱乐媒体");
const candidatesWithFollowUp = buildTopicCandidates([...obituaryArticles, followUp], [...obituarySeeds, seed(followUp, "谢贤逝世", ["谢贤", "谢霆锋"])]);
assert.equal(candidatesWithFollowUp.length, 2, "家族コメントは訃報rootの裏付けとして束ねない");
const root = candidatesWithFollowUp.find((candidate) => candidate.topic_key === "谢贤逝世");
const angle = candidatesWithFollowUp.find((candidate) => candidate.topic_key !== "谢贤逝世");
assert.equal(root?.source_count, 2, "関連角度を訃報のsource_countに加算しない");
assert.equal(angle?.topic_key, "谢贤逝世-谢霆锋回应");
assert.equal(angle?.source_count, 1);

console.log("topic canonicalization checks passed");

function article(url: string, title: string, sourceName: string): RawArticle {
  return {
    title,
    url,
    sourceName,
    sourceUrl: "https://example.test",
    category: "entertainment",
    reliability: "B",
    sourceType: "media_report",
    articleType: "news_event",
    publishedDate: "2026-08-01",
    freshnessLabel: "today",
    newsworthinessScore: 70
  };
}

function seed(article: RawArticle, topicKey: string, people = ["谢贤"]): TopicSeed {
  return {
    article_url: article.url,
    article_title: article.title,
    fallback_topic_key: topicKey,
    topic_key: topicKey,
    event_sentence: "テスト用の出来事文です。",
    entities: { people, works: [], organizations: [], events: [] },
    search_queries: [topicKey],
    confidence: 0.8,
    source: "llm"
  };
}
