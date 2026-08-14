import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { MAX_WEIGHTED_LENGTH, buildBingtangHook, buildDailyDigest, buildIndividualPosts, xWeightedLength } from "./site/xPostTexts.js";
import type { ProcessedArticle } from "./types.js";

const article = fixtureArticle();
const hook = buildBingtangHook(article.summary?.why_it_matters, 76);
assert.equal(hook, "ビンタン「この配役、原作の関係性がどう映像になるか気になります！」");
assert.ok(xWeightedLength(hook) <= 76);

const individual = buildIndividualPosts([article])[0];
assert.match(individual.text, /^【ドラマ】新ドラマの主要キャストが発表\nビンタン「/u);
assert.ok(individual.text.includes("原作の関係性"), "個別投稿は注目ポイントの中身を使う");
assert.ok(individual.weightedLength <= MAX_WEIGHTED_LENGTH);

const digest = buildDailyDigest("2026-08-14", [article, article, article], "https://example.test");
assert.match(digest, /^🧊 今日の中国エンタメ｜8\/14\nビンタン「/u);
assert.ok(digest.includes("原作の関係性"), "日次投稿も注目ポイントの中身を使う");
assert.ok(digest.includes("https://example.test/archive/2026-08-14/"));
assert.ok(xWeightedLength(digest) <= MAX_WEIGHTED_LENGTH);

const workflow = await fs.readFile(".github/workflows/review-apply.yml", "utf8");
for (const expected of [
  "Verify published daily page",
  "Reply with daily publication and X texts",
  "output/x_posts_${{ steps.review.outputs.date }}.md",
  "Verify published manual page",
  "output/manual_x_post_${{ steps.review.outputs.manual_id }}.md"
]) {
  assert.ok(workflow.includes(expected), `公開後通知フローに必要な設定がありません: ${expected}`);
}
assert.ok(workflow.indexOf("Verify published daily page") < workflow.indexOf("Reply with daily publication and X texts"));
assert.ok(workflow.indexOf("Verify published manual page") < workflow.indexOf("Reply with manual publication and X text"));

console.log("X post texts: ok");

function fixtureArticle(): ProcessedArticle {
  return {
    raw: {
      title: "新ドラマの主要キャストが発表",
      url: "https://example.com/news",
      sourceName: "Example",
      sourceUrl: "https://example.com/news",
      category: "ドラマ",
      reliability: "B"
    },
    summary: {
      title_ja: "新ドラマの主要キャストが発表",
      badge: "NEWS",
      lead: "制作側が主要キャストを発表しました。",
      what_happened: "制作側が主要キャストを発表しました。",
      why_it_matters: "この配役、原作の関係性がどう映像になるか気になります！ 続報も追いたいです。",
      reaction_view: "",
      editor_comment: "",
      japan_context_note: "",
      category: "ドラマ",
      confidence: "B",
      source_type: "media_report",
      published_date: "2026-08-14",
      event_date: "2026-08-14",
      freshness_label: "today",
      newsworthiness_score: 8,
      japan_visibility: "low",
      japan_gap: "high",
      context_value: "high",
      sns_heat: "none",
      source_count: 1,
      source_list: [{ name: "Example", url: "https://example.com/news" }],
      has_official_source: false,
      has_multiple_sources: false,
      has_sns_signal: false,
      article_type: "news_event",
      skip_reason: "",
      verification_status: "verified",
      topic_key: "fixture",
      main_entities: { people: [], works: [], organizations: [] },
      related_sources: [],
      tags: [],
      publish_priority: "high",
      publish_reason: "fixture",
      claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
    }
  };
}
