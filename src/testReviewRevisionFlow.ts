import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseReviewComment } from "./review/parseReviewComment.js";
import { appendAppliedVersion, appendProposalInstruction, applyProposal, beginFileTransaction, discardProposal, ensureInitialVersion, readRevisionStore, restorePendingProposalState, revertToVersion, revisionStorePath, saveProposal, withReviewMutationTransaction } from "./review/revisionStore.js";
import { createReviewStateFromStoredArticles, deriveReviewStatus, hasPublishRequired, normalizeReviewState, queueApprovedArticlesForPublication } from "./review/reviewState.js";
import { detectReviewRevisionIntent, tryApplyDeterministicTerminologyReplacement } from "./review/revisionPatch.js";
import { humanRevisionFailure } from "./review/revisionReply.js";
import type { ProcessedArticle, SummarizedArticle } from "./types.js";

const summary: SummarizedArticle = {
  title_ja: "初稿", badge: "NEWS", lead: "リード", what_happened: "本文", why_it_matters: "注目点", reaction_view: "", editor_comment: "", japan_context_note: "",
  category: "映画", confidence: "B", source_type: "media_report", published_date: "2026-09-03", event_date: "2026-09-03", freshness_label: "today", newsworthiness_score: 1,
  japan_visibility: "low", japan_gap: "low", context_value: "low", sns_heat: "none", source_count: 1, source_list: [{ name: "source", url: "https://example.com/evidence" }],
  has_official_source: false, has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "verified", topic_key: "fixture",
  main_entities: { people: [], works: [], organizations: [] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "fixture",
  claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
};

const parsed = parseReviewComment("1 保留\n2 作品名は A → B に直してください\n本文には一文追加\n3 適用 採用\n4 やめる\n5 初版に戻す\n6 戻す");
assert.deepEqual(parsed.invalidLines, []);
assert.deepEqual(parsed.decisions.map((item) => item.action), ["held", "revision_requested", "proposal_apply_approve", "proposal_discard", "revert_initial", "revert_previous"]);
assert.match(parsed.decisions[1].comment, /本文には一文追加/u, "番号付き自由文と継続行を一つの修正指示として扱う");
assert.deepEqual(parseReviewComment("- 1 採用\n・2 保留\n* 3 適用").decisions.map((item) => item.action), ["approved", "held", "proposal_apply"], "GitHubの箇条書き付き指示も受け付ける");
for (const failure of ["claim C1 is unavailable", "number_not_in_ledger: 2人", "clarification_required field=what_happened", "fact ledger missing"]) {
  const reply = humanRevisionFailure(new Error(failure));
  assert.doesNotMatch(reply, /claim|ledger|field|clarification_required|パッチ/u, "内部語を返信に出さない");
}
for (const instruction of ["作品名は 初稿 → 修正版 に直してください", "作品名は 初稿 → 修正版 へ修正してください", "作品名は 初稿 → 修正版 に変更してください", "作品名は 初稿 → 修正版 に統一してください"]) {
  const noTagIntent = detectReviewRevisionIntent(summary, instruction, "その他");
  assert.equal(tryApplyDeterministicTerminologyReplacement(summary, instruction, "その他", noTagIntent)?.summary.title_ja, "修正版", `理由タグなしの純粋な明示置換を即時適用できる: ${instruction}`);
}

const stored: ProcessedArticle = {
  raw: { title: "fixture", url: "https://example.com", sourceName: "source", sourceUrl: "https://example.com", category: "映画", reliability: "B" },
  summary,
  topic: { topic_key: "fixture" } as ProcessedArticle["topic"]
};
const created = createReviewStateFromStoredArticles([stored], "2026-09-03");
assert.match(created.articles[0].article_id || "", /^a-/u, "表示番号とは別の安定した記事IDを作る");
assert.equal(created.articles[0].publication?.slug, "1");
const oldCompleted = normalizeReviewState({
  date: "2026-09-01", status: "completed", issue_number: 1,
  articles: [
    { index: 1, topic_key: "a", title: "a", status: "rejected", reason_tag: "", comment: "", revision_count: 0 },
    { index: 2, topic_key: "b", title: "b", status: "approved", reason_tag: "", comment: "", revision_count: 0 },
    { index: 3, topic_key: "c", title: "c", status: "approved", reason_tag: "", comment: "", revision_count: 0 }
  ]
});
assert.deepEqual(oldCompleted.articles.map((article) => article.publication?.slug), ["u-1", "1", "2"], "旧完了日の公開URLは採用順を維持する");
assert.equal(oldCompleted.articles[1].publication?.published_version, 1, "旧公開記事はversion 1として移行する");
assert.equal(oldCompleted.articles[1].publication?.published_at, "2026-09-01T00:00:00+08:00", "旧公開記事を次回buildで消さない");
const newlyCompleted = normalizeReviewState({
  ...created,
  status: "completed",
  articles: [{ ...created.articles[0], status: "approved" }]
});
assert.equal(newlyCompleted.articles[0].publication?.published_at, undefined, "新規レビューは完了してもdeploy前に公開済みへ移行しない");
assert.equal(hasPublishRequired(newlyCompleted.articles), true, "新規完了レビューは初回deployを要求する");
queueApprovedArticlesForPublication(newlyCompleted.articles, "2026-09-03T09:00:00+08:00");
assert.equal(newlyCompleted.articles[0].publication?.queued_at, "2026-09-03T09:00:00+08:00", "初回承認時だけ公開キュー時刻を保存する");
assert.equal(deriveReviewStatus([{ ...created.articles[0], status: "approved" }, { ...created.articles[0], index: 2, status: "held" }]), "completed");
assert.equal(deriveReviewStatus([{ ...created.articles[0], status: "approved" }, { ...created.articles[0], index: 2, status: "proposal_pending" }]), "pending");
assert.equal(hasPublishRequired([{ ...created.articles[0], status: "approved" }]), true, "初稿の採用だけでも部分公開を要求する");
assert.equal(hasPublishRequired([{ ...created.articles[0], status: "approved", current_version: 2, publication: { slug: "1", published_at: "2026-09-03", published_version: 2 } }]), false);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-version-flow-"));
try {
  const articleId = created.articles[0].article_id!;
  const articlePath = path.join(directory, "articles_2026-09-03.json");
  await fs.writeFile(articlePath, "original-article", "utf8");
  await assert.rejects(
    () => withReviewMutationTransaction(directory, articlePath, async () => {
      await fs.writeFile(articlePath, "partly-updated-article", "utf8");
      await fs.writeFile(revisionStorePath(directory), "partly-updated-revisions", "utf8");
      throw new Error("simulated article write failure");
    }),
    /simulated article write failure/u
  );
  assert.equal(await fs.readFile(articlePath, "utf8"), "original-article", "記事書込失敗時は記事を元のままに戻す");
  await assert.rejects(() => fs.readFile(revisionStorePath(directory), "utf8"), { code: "ENOENT" }, "記事書込失敗時は新しい版履歴も残さない");
  const reviewPath = path.join(directory, "review.json");
  await fs.writeFile(reviewPath, "original-review", "utf8");
  await fs.writeFile(revisionStorePath(directory), "original-revisions", "utf8");
  const commentTransaction = await beginFileTransaction([reviewPath, articlePath, revisionStorePath(directory)]);
  await assert.rejects(async () => {
    try {
      await fs.writeFile(articlePath, "updated-article", "utf8");
      await fs.writeFile(revisionStorePath(directory), "updated-revisions", "utf8");
      // This final write represents review.json failing after both content
      // files were changed in one review-comment operation.
      await fs.writeFile(reviewPath, "partly-written-review", "utf8");
      throw new Error("simulated final review state write failure");
    } catch (error) {
      await commentTransaction.rollback();
      throw error;
    }
  }, /simulated final review state write failure/u);
  assert.equal(await fs.readFile(reviewPath, "utf8"), "original-review");
  assert.equal(await fs.readFile(articlePath, "utf8"), "original-article");
  assert.equal(await fs.readFile(revisionStorePath(directory), "utf8"), "original-revisions", "review state最終書込失敗時は3ファイルを元のbytesへ戻す");
  await fs.rm(revisionStorePath(directory), { force: true });
  const initial = await ensureInitialVersion(directory, "2026-09-03", articleId, summary);
  assert.equal(initial.currentVersion, 1, "最初の修正前に初稿を不変保存する");
  const candidate = { ...summary, title_ja: "修正案" };
  const proposal = await saveProposal(directory, "2026-09-03", articleId, summary, {
    instruction: "タイトルだけ変更", mode: "limited_patch", summary: "タイトルを変更", evidence_urls: [], previous_status: "pending", article_summary: candidate
  });
  const applied = await applyProposal(directory, "2026-09-03", articleId, proposal.id);
  assert.equal(applied.version, 2);
  assert.equal(applied.summary.title_ja, "修正案");
  const replacementInstruction = appendProposalInstruction("タイトルだけ変更", "本文に一文追加");
  assert.match(replacementInstruction, /タイトルだけ変更[\s\S]*追加指示[\s\S]*本文に一文追加/u, "提案の作り直しでも元指示を失わない");
  const pending = await saveProposal(directory, "2026-09-03", articleId, applied.summary, {
    instruction: "元の指示", mode: "limited_patch", summary: "旧案", evidence_urls: [], previous_status: "pending", article_summary: { ...summary, title_ja: "旧案" }
  });
  const replacement = await saveProposal(directory, "2026-09-03", articleId, applied.summary, {
    instruction: appendProposalInstruction(pending.instruction, "追加指示"), mode: "limited_patch", summary: "新案", evidence_urls: [], previous_status: pending.previous_status, article_summary: { ...summary, title_ja: "新案" }
  });
  await discardProposal(directory, "2026-09-03", articleId, pending.id);
  const storeAfterReplacement = await readRevisionStore(directory, "2026-09-03");
  assert.equal(storeAfterReplacement.articles[articleId].proposals.find((item) => item.id === pending.id)?.status, "discarded", "新案の保存成功後にだけ旧案を取りやめる");
  assert.equal(storeAfterReplacement.articles[articleId].proposals.find((item) => item.id === replacement.id)?.previous_status, "pending", "作り直した案は元の状態へ戻れる");
  const visiblePending = { ...created.articles[0], status: "pending" as const, pending_proposal_id: undefined };
  restorePendingProposalState(visiblePending, replacement);
  assert.equal(visiblePending.status, "proposal_pending", "作り直しに失敗しても旧提案をUIから隠さない");
  assert.equal(visiblePending.pending_proposal_id, replacement.id);
  const discard = await saveProposal(directory, "2026-09-03", articleId, applied.summary, {
    instruction: "やめる案", mode: "limited_patch", summary: "破棄", evidence_urls: [], previous_status: "revised_pending", article_summary: { ...summary, title_ja: "破棄対象" }
  });
  assert.equal((await discardProposal(directory, "2026-09-03", articleId, discard.id)).status, "discarded");
  const stale = await saveProposal(directory, "2026-09-03", articleId, applied.summary, {
    instruction: "古い案", mode: "limited_patch", summary: "古い案", evidence_urls: [], previous_status: "revised_pending", article_summary: { ...summary, title_ja: "古い案" }
  });
  await appendAppliedVersion(directory, "2026-09-03", articleId, applied.summary, { ...summary, title_ja: "別の版" }, "explicit_replacement", "別の変更");
  await assert.rejects(() => applyProposal(directory, "2026-09-03", articleId, stale.id), /更新された後/u, "古い修正案は適用しない");
  const reverted = await revertToVersion(directory, "2026-09-03", articleId, { ...summary, title_ja: "別の版" }, "initial");
  assert.equal(reverted.summary.title_ja, "初稿");
  assert.equal(reverted.version, 4, "戻す操作も新しい監査可能な版として残す");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log("review revision flow tests passed.");
