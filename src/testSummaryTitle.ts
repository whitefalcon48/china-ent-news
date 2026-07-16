import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { resolveSummaryTitle } from "./summaryTitle.js";
import type { ProcessedArticle } from "./types.js";

assert.equal(resolveSummaryTitle("生成済みタイトル", "元記事タイトル"), "生成済みタイトル");
assert.equal(resolveSummaryTitle("", "元記事タイトル"), "元記事タイトル");
assert.equal(resolveSummaryTitle("   ", "元記事タイトル"), "元記事タイトル");
assert.equal(resolveSummaryTitle("タイトル未設定", "元記事タイトル"), "元記事タイトル");
assert.equal(resolveSummaryTitle(undefined, "", "topic title"), "topic title");
assert.equal(resolveSummaryTitle("タイトル未設定"), "");

const renderedPath = await renderMarkdownFile(
  [
    {
      raw: {
        title: "元記事タイトル",
        url: "https://example.com/article",
        sourceName: "テスト媒体",
        category: "映画",
        reliability: "A"
      },
      summary: {
        title_ja: "タイトル未設定",
        badge: "NEWS",
        category: "映画",
        confidence: "A",
        source_type: "media_report",
        freshness_label: "recent",
        publish_priority: "medium",
        newsworthiness_score: 50,
        source_list: [{ name: "テスト媒体", url: "https://example.com/article" }]
      }
    } as ProcessedArticle
  ],
  "gemini",
  "2000-01-01"
);

try {
  const rendered = await fs.readFile(renderedPath, "utf8");
  assert.match(rendered, /元記事タイトル/);
  assert.doesNotMatch(rendered, /タイトル未設定/);
} finally {
  await fs.rm(renderedPath, { force: true });
}

console.log("summary title fallback: ok");
