import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatReviewArticle, formatReviewProposalSummary, formatReviewRevisionSummary } from "./review/buildReviewIssueBody.js";
import { renderUi } from "./review/uiServer.js";
import type { ProcessedArticle } from "./types.js";
import { fetchReviewData, loadLocalReviewData, type ReviewCommandRunner, type ReviewUiData } from "./review/fetchReviewData.js";

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
assert.match(revisionScope, /### 修正した箇所/u);
assert.match(revisionScope, /何が起きたか: 「旧日付」 → 「新日付」/u);
assert.match(revisionScope, /変更していない本文・ソース: そのまま保持/u);
assert.doesNotMatch(revisionScope, /claim refs/u);

const proposal = formatReviewProposalSummary({
  instruction: "作品名を直し、初稿の雰囲気を維持する",
  summary: "タイトルの意味を本文に一文追加します。",
  trace: { changes: [{ field: "title_ja", before: "歓迎竜レストランへ", after: "ようこそ龍レストランへ", reason: "作品名の表記を修正" }] },
  untouched: ["リード", "注目ポイント"],
  deleted_information: [],
  evidence_urls: ["https://example.com/evidence"]
});
assert.match(proposal, /修正案/u);
assert.match(proposal, /歓迎竜レストランへ.*ようこそ龍レストランへ/u);
assert.match(proposal, /変更しない部分: リード、注目ポイント/u);
assert.match(proposal, /削除情報: なし/u);
assert.match(proposal, /https:\/\/example\.com\/evidence/u);
assert.doesNotMatch(proposal, /claim|limited_patch|clarification_required/u);

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
assert.doesNotMatch(detailedIssue, /claim|C5|C6/u, "Issue本文に内部の根拠IDを出さない");

const uiData = {
  days: [{
    date: "2026-08-09",
    issueNumber: 1,
    issueUrl: "https://example.com/issues/1",
    review: {
      date: "2026-08-09",
      status: "pending",
      issue_number: 1,
      articles: [{ index: 1, topic_key: "topic", title: "記事タイトル", status: "revised_pending", reason_tag: "口調", comment: "修正指示", revision_count: 1, publication: { published_at: "2026-08-09T12:00:00Z" } }]
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
assert.match(ui, /proposal_pending/, "修正案確認中の表示経路を持つ");
assert.match(ui, /if\(r\.pending_proposal_id\)appendProposal\(c,r\)/u, "保留にした修正案も保留棚から適用・取りやめできる");
assert.match(ui, /修正案（元の記事はまだ変更していません）/u);
assert.match(ui, /apply_approved.*適用して採用/u);
assert.match(ui, /revert_previous.*一つ前に戻す/u);
assert.match(ui, /revert_initial.*初版に戻す/u);
assert.match(ui, /held.*保留/u);
assert.match(ui, /今回送る判定/u);
assert.match(ui, /送信する判定を1件以上選んでください/u);
assert.match(ui, /r\.publication\?\.published_at/, "公開済み判定はpublished_atを使う");
assert.match(ui, /公開済み/, "公開済み表示を持つ");
assert.match(ui, /\['pending','revised_pending'\]\.includes\(r\.status\)/u, "残りを採用は未判定・修正待ちだけに限定する");
assert.doesNotMatch(ui, /approveRest[^]*if\(!states\[r\.index\]\)states/u, "残りを採用で保留・却下・修正案確認中を誤って採用しない");
assert.match(ui, /for\(const section of s\.detail_sections\|\|\[\]\)/, "UIは根拠詳細節を表示する");

const fixtureDate = "2026-08-10";
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-review-ui-"));
await fs.mkdir(path.join(fixtureRoot, fixtureDate));
const heldReview = {
  date: fixtureDate,
  status: "completed",
  issue_number: 42,
  articles: [{ index: 1, topic_key: "topic", title: "保留記事", status: "held", reason_tag: "", comment: "あとで確認", revision_count: 0 }]
};
await fs.writeFile(path.join(fixtureRoot, fixtureDate, "review.json"), JSON.stringify(heldReview));
await fs.writeFile(path.join(fixtureRoot, fixtureDate, `articles_${fixtureDate}.json`), JSON.stringify([article("")]));
await fs.writeFile(path.join(fixtureRoot, fixtureDate, "revisions.json"), JSON.stringify({ articles: { "1": { versions: [], proposals: [] } } }));
const localHeld = await loadLocalReviewData(fixtureRoot, "", async (command) => command === "gh" ? JSON.stringify({ nameWithOwner: "owner/repo" }) : "");
assert.equal(localHeld.days.length, 1, "completedでもheldの記事を保留棚に残す");
assert.ok(localHeld.days[0].revisions, "revisions.jsonを任意読込する");
await fs.rm(path.join(fixtureRoot, fixtureDate, "revisions.json"), { force: true });
const localLegacy = await loadLocalReviewData(fixtureRoot, "", async (command) => command === "gh" ? JSON.stringify({ nameWithOwner: "owner/repo" }) : "");
assert.equal(localLegacy.days.length, 1, "旧revisionsなしでも記事表示を維持する");
assert.equal(localLegacy.days[0].revisions, undefined);

const encoded = (value: unknown) => ({ encoding: "base64", content: Buffer.from(JSON.stringify(value)).toString("base64") });
const githubCalls: string[][] = [];
const githubRunner: ReviewCommandRunner = async (_command, args) => {
  githubCalls.push(args);
  if (args.includes("nameWithOwner")) return JSON.stringify({ nameWithOwner: "owner/repo" });
  if (args.includes("daily-review") && args.includes("open")) return JSON.stringify([]);
  if (args.includes("daily-review") && args.includes("closed")) return JSON.stringify([{ number: 42, title: `📋 ニュースレビュー ${fixtureDate}`, url: "https://github.com/owner/repo/issues/42" }]);
  const target = args.find((value) => value.includes("contents/data/")) || "";
  if (target.endsWith("review.json")) return JSON.stringify(encoded(heldReview));
  if (target.endsWith("articles_2026-08-10.json")) return JSON.stringify(encoded([article("")]));
  throw new Error("404 revisions.json");
};
const githubHeld = await fetchReviewData({ runner: githubRunner });
assert.equal(githubHeld.days.length, 1, "GitHub取得でもcompleted+heldを対象にする");
assert.equal(githubHeld.days[0].revisions, undefined, "revisions取得失敗は記事表示を壊さない");
assert.ok(githubCalls.some((args) => args.includes("daily-review") && args.includes("closed")), "closedになった保留レビューもGitHubから取得する");
await fs.rm(fixtureRoot, { recursive: true, force: true });

console.log("review presentation tests passed.");
