import assert from "node:assert/strict";
import { formatReviewArticle, formatReviewRevisionSummary } from "./review/buildReviewIssueBody.js";
import { renderUi } from "./review/uiServer.js";
import type { ProcessedArticle } from "./types.js";
import type { ReviewUiData } from "./review/fetchReviewData.js";

function article(japanContextNote: string): ProcessedArticle {
  return {
    raw: {
      title: "原題",
      url: "https://example.com/story",
      sourceName: "媒体",
      sourceUrl: "https://example.com/",
      category: "映画",
      reliability: "B"
    },
    summary: {
      title_ja: "記事タイトル",
      badge: "NEWS",
      lead: "リード",
      what_happened: "出来事",
      why_it_matters: "注目ポイント本文",
      reaction_view: "確認できた反応",
      japan_context_note: japanContextNote,
      category: "映画",
      confidence: "B",
      source_list: [{ name: "媒体", url: "https://example.com/story" }]
    }
  } as ProcessedArticle;
}

const withSupplement = formatReviewArticle(1, article("  補足本文  "));
assert.match(withSupplement, /\*\*ビンタンの注目ポイント\*\*: 注目ポイント本文\n\n\*\*ビンタンからの補足\*\*: 補足本文\n\nソース:/);

const withoutSupplement = formatReviewArticle(1, article("   "));
assert.doesNotMatch(withoutSupplement, /ビンタンからの補足/);
assert.match(withoutSupplement, /\*\*反応・見られ方\*\*: 確認できた反応/, "レビューIssueにも通常記事の反応欄を表示する");

const withUndefinedSupplement = article("");
withUndefinedSupplement.summary!.japan_context_note = undefined as unknown as string;
assert.doesNotMatch(formatReviewArticle(1, withUndefinedSupplement), /ビンタンからの補足/);

const revised = formatReviewArticle(1, article("修正版の補足"), true);
assert.match(revised, /^## 🔄 修正版 1/m);
assert.match(revised, /\*\*ビンタンからの補足\*\*: 修正版の補足/);

const revisionScope = formatReviewRevisionSummary({
  mode: "limited_patch",
  changed_fields: ["what_happened"],
  changes: [{ field: "what_happened", before: "旧日付", after: "新日付", evidence_claim_refs: ["C2"], reason: "日付を訂正" }],
  preservation: {
    untouched_fields_exact: true,
    source_list_exact: true,
    related_sources_exact: true,
    reaction_view_preserved_when_untargeted: true,
    claim_refs_before: 4,
    claim_refs_after: 5,
    important_numbers_before: [],
    important_numbers_after: [],
    entities_before: [],
    entities_after: [],
    narrative_chars_before: 100,
    narrative_chars_after: 102
  }
});
assert.match(revisionScope, /指定箇所だけの限定パッチ/u);
assert.match(revisionScope, /`what_happened`: 日付を訂正/u);
assert.match(revisionScope, /非対象フィールド: 完全一致を確認/u);
assert.match(revisionScope, /claim refs: 4件 → 5件/u);

const withRelatedAngle = article("");
withRelatedAngle.summary!.related_sources = [
  { name: "関連媒体", url: "https://example.com/angle" },
  { name: "媒体", url: "https://example.com/story" }
];
const relatedIssue = formatReviewArticle(1, withRelatedAngle);
assert.match(relatedIssue, /ソース: \[媒体\]/, "中心事実のソースを維持する");
assert.match(relatedIssue, /関連角度のソース: \[関連媒体\]/, "関連角度だけを別見出しにする");
assert.equal((relatedIssue.match(/https:\/\/example\.com\/story/g) ?? []).length, 1, "root sourceを関連角度として重複表示しない");

const withDetails = article("");
withDetails.summary!.detail_sections = [{ heading: "映画館の変化", body: "映画館が複合施設へ変わっています。", claim_refs: ["C5", "C6"] }];
const detailedIssue = formatReviewArticle(1, withDetails);
assert.match(detailedIssue, /### 映画館の変化/);
assert.match(detailedIssue, /根拠claim: C5, C6/);

const uiData = {
  days: [{
    date: "2026-08-09",
    issueNumber: 1,
    issueUrl: "https://example.com/issues/1",
    review: {
      date: "2026-08-09",
      status: "pending",
      issue_number: 1,
      articles: [{ index: 1, topic_key: "topic", title: "記事タイトル", status: "revised_pending", reason_tag: "口調", comment: "修正指示", revision_count: 1 }]
    },
    articles: [article("UIの補足本文")]
  }],
  warning: "",
  source: "local"
} as ReviewUiData;

const ui = renderUi(uiData, "token");
assert.match(ui, /const supplement=typeof s\.japan_context_note==='string'\?s\.japan_context_note\.trim\(\):'';if\(supplement\)/, "UIは空でない補足だけを表示する");
assert.match(ui, /supplementBox\.append\(el\('h3','','ビンタンからの補足'\),el\('p','',supplement\)\)/, "UIはtextContentを使うel経由で補足を独立表示する");
assert.match(ui, /UIの補足本文/, "UIへ補足本文を渡す");
assert.match(ui, /appendSources\(c,'関連角度のソース:',s\.related_sources\|\|\[\],s\.source_list\|\|\[\]\)/, "UIは関連角度のソースをrootと別に扱う");
assert.match(ui, /reactionSummary=el\('summary','','反応・見られ方'\)/, "UIにも通常記事の反応欄を表示する");
assert.match(ui, /revised_pending/, "修正版の表示経路でも同じカードを使う");
assert.match(ui, /for\(const section of s\.detail_sections\|\|\[\]\)/, "UIは根拠詳細節を表示する");

console.log("review presentation tests passed.");
