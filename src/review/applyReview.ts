import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatReviewArticle, formatReviewProposalSummary, formatReviewRevisionSummary } from "./buildReviewIssueBody.js";
import { parseReviewComment, type ReviewDecision } from "./parseReviewComment.js";
import { deriveReviewStatus, hasPublishRequired, hasUncertainXPost, hasXPostRequired, queueApprovedArticlesForPublication, readReviewState, today, writeReviewState } from "./reviewState.js";
import { prepareStoredArticleRevision } from "./reviseArticle.js";
import { appendAppliedVersion, appendProposalInstruction, applyProposal, beginFileTransaction, discardProposal, ensureInitialVersion, readRevisionStore, restorePendingProposalState, revertToVersion, revisionStorePath, saveProposal, withReviewMutationTransaction } from "./revisionStore.js";
import { rescueEmptyReview } from "./rescueEmptyReview.js";
import { ToneOnlyRevisionContractError } from "../toneOnlyRevision.js";
import { captureManualPublication, findManualReviewPath, markManualIntakePublished } from "./manualPublication.js";
import { ReviewRevisionClarificationRequiredError } from "./revisionPatch.js";
import { humanRevisionFailure } from "./revisionReply.js";
import type { ProcessedArticle, ReviewArticle, ReviewFeedback, ReviewState } from "../types.js";

async function main() {
  if (process.env.REVIEW_GATE === "false") return;
  const body = process.env.REVIEW_COMMENT || process.env.COMMENT_BODY || "";
  if (!body.trim()) throw new Error("REVIEW_COMMENT is required");
  const issueNumber = Number(process.env.REVIEW_ISSUE_NUMBER || process.env.ISSUE_NUMBER || 0);
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const locatedReview = await findReviewPath(dataDir, issueNumber, process.env.REVIEW_DATE, process.env.MANUAL_COMMENT_ID);
  const reviewPath = locatedReview.reviewPath;
  const directory = path.dirname(reviewPath);
  const state = await readReviewState(reviewPath);
  const wasCompleted = state.status === "completed";
  const parsed = parseReviewComment(body);
  const feedback: ReviewFeedback[] = [];
  const replies: string[] = [];
  const reviewTransaction = await beginFileTransaction([reviewPath, await storedArticlePath(directory), revisionStorePath(directory)]);

  try {
  for (const decision of parsed.decisions) {
    if (decision.action === "rescue_rebuild") {
      if (state.status === "completed") {
        replies.push("⚠️ このレビューは完了済みのため、救済再生成では自動的に再オープンしませんでした。");
        continue;
      }
      const rescued = await rescueEmptyReview(directory, state.date);
      if (!rescued.ok) {
        replies.push(`⚠️ ${rescued.message}`);
        continue;
      }
      state.articles = rescued.articles.map((article, position) => ({
        index: position + 1,
        topic_key: article.topic?.topic_key ?? article.summary?.topic_key ?? "",
        title: article.summary?.title_ja ?? article.raw.title,
        status: "pending",
        reason_tag: "",
        comment: "",
        revision_count: 0
      }));
      state.status = "pending";
      replies.push(`🔄 救済再生成: EVS 6点の保存候補 ${rescued.articles.length}本を保留記事として作成しました。採用されるまで公開されません。`);
      replies.push(...rescued.articles.map((article, position) => formatReviewArticle(position + 1, article)));
      continue;
    }
    const targets = selectTargets(state, decision);
    if (!targets.length && decision.index !== undefined) {
      parsed.invalidLines.push(`${decision.index}: 記事番号がありません`);
      continue;
    }
    for (const target of targets) {
      if (decision.action === "approved" || decision.action === "remaining_approved") {
        if (target.pending_proposal_id) {
          replies.push(`⚠️ ${target.index}番は修正案を確認中です。記事を採用するには「${target.index} 適用 採用」、取りやめるには「${target.index} やめる」と返信してください。`);
          continue;
        }
        setDecision(target, "approved", "", "");
        continue;
      }
      if (decision.action === "rejected" || decision.action === "remaining_rejected") {
        if (target.article_id && target.pending_proposal_id) {
          try {
            await discardProposal(directory, state.date, target.article_id, target.pending_proposal_id);
            target.pending_proposal_id = undefined;
            replies.push(`↩️ ${target.index}番の修正案を取りやめてから却下にしました。`);
          } catch (error) {
            replies.push(`⚠️ ${target.index}番の修正案を取りやめられないため、却下にはしていません。${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        }
        setDecision(target, "rejected", decision.reasonTag, decision.comment);
        feedback.push(await buildFeedback(directory, state.date, target, "rejected"));
        continue;
      }
      if (decision.action === "held") {
        setDecision(target, "held", decision.reasonTag, decision.comment);
        replies.push(`⏸️ ${target.index}番を保留にしました。却下として記録せず、ほかの記事は先に公開できます。${target.pending_proposal_id ? ` 修正案は保持しているため、後日「${target.index} 適用」で反映できます。` : ""}`);
        continue;
      }
      if (decision.action === "proposal_apply" || decision.action === "proposal_apply_approve") {
        await applyPendingProposal(directory, state, target, decision.action === "proposal_apply_approve", replies);
        continue;
      }
      if (decision.action === "proposal_discard") {
        await discardPendingProposal(directory, state, target, replies);
        continue;
      }
      if (decision.action === "revert_initial" || decision.action === "revert_previous") {
        await revertStoredArticle(directory, state, target, decision.action === "revert_initial" ? "initial" : "previous", replies);
        continue;
      }
      const pending = target.article_id && target.pending_proposal_id
        ? (await readRevisionStore(directory, state.date)).articles[target.article_id]?.proposals.find((proposal) => proposal.id === target.pending_proposal_id && proposal.status === "pending")
        : undefined;
      const previousStatus = pending?.previous_status ?? target.status;
      const instruction = pending ? appendProposalInstruction(pending.instruction, decision.comment) : decision.comment;
      try {
        const prepared = await prepareStoredArticleRevision(directory, target.index, instruction, decision.reasonTag);
        const current = await readStoredArticle(directory, target.index);
        const articleId = target.article_id;
        if (!articleId || !current.summary) throw new Error("記事の版履歴を初期化できませんでした");
        if (prepared.kind === "immediate") {
          const articlePath = await storedArticlePath(directory);
          let version = target.current_version ?? 1;
          await withReviewMutationTransaction(directory, articlePath, async () => {
            const initialized = await ensureInitialVersion(directory, state.date, articleId, current.summary!);
            version = await appendAppliedVersion(directory, state.date, articleId, current.summary!, prepared.article.summary!, "explicit_replacement", prepared.summary);
            await writeStoredArticle(directory, target.index, prepared.article);
            target.current_version = initialized.currentVersion;
          });
          target.current_version = version;
          target.pending_proposal_id = undefined;
          target.revision_count += 1;
          target.status = "revised_pending";
          target.title = prepared.article.summary?.title_ja || target.title;
          replies.push(formatReviewArticle(target.index, prepared.article, true));
          const revisionSummary = formatReviewRevisionSummary(prepared.trace);
          if (revisionSummary) replies.push(`${revisionSummary}\n\n必要なら「${target.index} 戻す」で直前の版へ、「${target.index} 初版に戻す」で初稿へ戻せます。`);
        } else {
          const articlePath = await storedArticlePath(directory);
          const { initialized, proposal } = await withReviewMutationTransaction(directory, articlePath, async () => {
            const initialized = await ensureInitialVersion(directory, state.date, articleId, current.summary!);
            const proposal = await saveProposal(directory, state.date, articleId, current.summary!, {
              instruction,
              mode: prepared.mode,
              summary: prepared.summary,
              trace: prepared.trace,
              evidence_urls: prepared.evidenceUrls,
              previous_status: previousStatus,
              article_summary: prepared.article.summary!
            });
            // Do not lose the visible previous proposal unless its replacement
            // is completely stored; transaction rollback restores it on IO error.
            if (pending && target.article_id && target.pending_proposal_id) {
              await discardProposal(directory, state.date, target.article_id, target.pending_proposal_id);
            }
            return { initialized, proposal };
          });
          target.current_version = initialized.currentVersion;
          target.status = "proposal_pending";
          target.reason_tag = decision.reasonTag;
          target.comment = instruction;
          target.pending_proposal_id = proposal.id;
          replies.push(formatReviewProposalSummary(proposal));
          replies.push(`確認後は「${target.index} 適用」、採用まで確定するなら「${target.index} 適用 採用」、取りやめるなら「${target.index} やめる」と返信してください。`);
        }
      } catch (error) {
        if (pending) {
          restorePendingProposalState(target, pending);
        } else target.status = previousStatus;
        if (error instanceof ReviewRevisionClarificationRequiredError) {
          console.warn(`review proposal unavailable for ${target.index}:`, error.message);
          replies.push(`⚠️ ${target.index}番の元の記事は変更していません。${humanRevisionFailure(error)}`);
          continue;
        }
        if (error instanceof ToneOnlyRevisionContractError) {
          console.warn(`review tone revision unavailable for ${target.index}:`, error.message);
          replies.push(`⚠️ ${target.index}番は、口調だけの修正として確認できなかったため、元の記事を保持しました。${humanRevisionFailure(error)}`);
          continue;
        }
        console.warn(`review proposal failed for ${target.index}:`, error);
        replies.push(`⚠️ ${target.index}番の元の記事は変更していません。${humanRevisionFailure(error)}`);
      }
    }
  }

  state.status = deriveReviewStatus(state.articles);
  queueApprovedArticlesForPublication(state.articles, shanghaiTimestamp());
  await writeReviewState(reviewPath, state);
  } catch (error) {
    await reviewTransaction.rollback();
    throw error;
  }
  if (feedback.length) await appendFeedback(dataDir, feedback);
  if (parsed.invalidLines.length) replies.push(`⚠️ 解釈できなかった行\n\n${parsed.invalidLines.map((line) => `- ${line}`).join("\n")}`);
  if (state.status === "completed") replies.push(buildCompletionSummary(state));
  const hasApprovedManualArticle = Boolean(!wasCompleted && locatedReview.commentId && state.articles.some((article) => article.status === "approved"));
  const manualPublication = hasApprovedManualArticle && locatedReview.commentId
    ? captureManualPublication(locatedReview.commentId, process.env.SITE_URL || "https://bingtangnews.0-w-0.net", today)
    : undefined;
  if (state.status === "completed" && locatedReview.commentId && manualPublication) {
    await markManualIntakePublished(dataDir, locatedReview.commentId, manualPublication.publishedDate, manualPublication.publishedUrl);
    replies.push(`🧊 持ち込み記事を公開キューに追加しました。公開後、このIssueにURLとX投稿文面を返信します。`);
  }
  await postReplies(issueNumber || state.issue_number, replies);
  if (process.env.GITHUB_OUTPUT) {
    const publishRequired = hasPublishRequired(state.articles);
    const xPostRequired = hasXPostRequired(state.articles);
    const xPostAttention = hasUncertainXPost(state.articles);
    await fs.appendFile(process.env.GITHUB_OUTPUT, `completed=${state.status === "completed"}\npublish_required=${publishRequired}\nx_post_required=${xPostRequired}\nx_post_attention=${xPostAttention}\ndate=${state.date}\nmanual=${Boolean(locatedReview.commentId)}\nmanual_id=${locatedReview.commentId || ""}\nmanual_published=${Boolean(manualPublication)}\npublished_date=${manualPublication?.publishedDate || ""}\n`, "utf8");
  }
  console.log(`review apply: ${state.date} / ${state.status}`);
}

async function applyPendingProposal(directory: string, state: ReviewState, target: ReviewArticle, approve: boolean, replies: string[]) {
  const articleId = target.article_id;
  const proposalId = target.pending_proposal_id;
  if (!articleId || !proposalId) {
    replies.push(`⚠️ ${target.index}番には適用できる修正案がありません。`);
    return;
  }
  try {
    const articlePath = await storedArticlePath(directory);
    const applied = await withReviewMutationTransaction(directory, articlePath, async () => {
      const next = await applyProposal(directory, state.date, articleId, proposalId);
      const current = await readStoredArticle(directory, target.index);
      if (!current.summary) throw new Error("元の記事を確認できませんでした");
      await writeStoredArticle(directory, target.index, {
        ...current,
        summary: next.summary,
        ...(current.generationMeta ? { generationMeta: { ...current.generationMeta, review_revision: next.proposal.trace } } : {})
      });
      return next;
    });
    target.current_version = applied.version;
    target.pending_proposal_id = undefined;
    target.revision_count += 1;
    target.status = approve ? "approved" : "revised_pending";
    target.title = applied.summary.title_ja || target.title;
    replies.push(`✅ ${target.index}番の修正案を適用しました。${approve ? "採用として公開対象にしました。" : "内容を確認して採用・保留・却下を決めてください。"}`);
  } catch (error) {
    replies.push(`⚠️ ${target.index}番の修正案は適用していません。${error instanceof Error ? error.message : String(error)}`);
  }
}

async function discardPendingProposal(directory: string, state: ReviewState, target: ReviewArticle, replies: string[]) {
  if (!target.article_id || !target.pending_proposal_id) {
    replies.push(`⚠️ ${target.index}番には取りやめる修正案がありません。`);
    return;
  }
  try {
    const proposal = await discardProposal(directory, state.date, target.article_id, target.pending_proposal_id);
    target.status = proposal.previous_status === "proposal_pending" ? "pending" : proposal.previous_status;
    target.pending_proposal_id = undefined;
    target.reason_tag = "";
    target.comment = "";
    replies.push(`↩️ ${target.index}番の修正案を取りやめ、元の記事を維持しました。`);
  } catch (error) {
    replies.push(`⚠️ ${target.index}番の修正案を取りやめられませんでした。${error instanceof Error ? error.message : String(error)}`);
  }
}

async function revertStoredArticle(directory: string, state: ReviewState, target: ReviewArticle, mode: "initial" | "previous", replies: string[]) {
  if (!target.article_id) {
    replies.push(`⚠️ ${target.index}番の版履歴を確認できませんでした。`);
    return;
  }
  try {
    const current = await readStoredArticle(directory, target.index);
    if (!current.summary) throw new Error("元の記事を確認できませんでした");
    const articlePath = await storedArticlePath(directory);
    const reverted = await withReviewMutationTransaction(directory, articlePath, async () => {
      const next = await revertToVersion(directory, state.date, target.article_id!, current.summary!, mode);
      await writeStoredArticle(directory, target.index, { ...current, summary: next.summary });
      return next;
    });
    target.current_version = reverted.version;
    target.pending_proposal_id = undefined;
    target.revision_count += 1;
    target.status = "revised_pending";
    target.title = reverted.summary.title_ja || target.title;
    replies.push(`↩️ ${target.index}番を${mode === "initial" ? "初稿" : "一つ前の版"}へ戻しました。確認後に採用してください。`);
  } catch (error) {
    replies.push(`⚠️ ${target.index}番を戻せませんでした。${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readStoredArticle(directory: string, index: number) {
  const articles = JSON.parse(await fs.readFile(await storedArticlePath(directory), "utf8")) as ProcessedArticle[];
  const article = articles[index - 1];
  if (!article) throw new Error("記事データを確認できませんでした");
  return article;
}

async function writeStoredArticle(directory: string, index: number, replacement: ProcessedArticle) {
  const articlePath = await storedArticlePath(directory);
  const articles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  if (!articles[index - 1]) throw new Error("記事データを確認できませんでした");
  articles[index - 1] = replacement;
  await fs.writeFile(articlePath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
}

async function storedArticlePath(directory: string) {
  const file = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!file) throw new Error("記事データを確認できませんでした");
  return path.join(directory, file);
}

function selectTargets(state: ReviewState, decision: ReviewDecision) {
  if (decision.action === "remaining_approved" || decision.action === "remaining_rejected") {
    return state.articles.filter((article) => article.status === "pending" || article.status === "revised_pending");
  }
  return state.articles.filter((article) => article.index === decision.index);
}

function setDecision(article: ReviewArticle, status: "approved" | "rejected" | "held" | "revision_requested", reasonTag: ReviewArticle["reason_tag"], comment: string) {
  article.status = status;
  article.reason_tag = reasonTag;
  article.comment = comment;
}

function shanghaiTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

async function buildFeedback(directory: string, date: string, review: ReviewArticle, action: ReviewFeedback["action"]): Promise<ReviewFeedback> {
  const file = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  const articles = file ? JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) as ProcessedArticle[] : [];
  const article = articles[review.index - 1];
  return {
    date,
    topic_key: review.topic_key,
    action,
    reason_tag: review.reason_tag || "その他",
    comment: review.comment,
    category: article?.summary?.category || article?.raw.category || "",
    topic_type: article?.topic?.topic_type || "",
    seed_confidence: article?.topic?.seed_confidence || 0,
    newsworthiness_score: article?.summary?.newsworthiness_score || article?.topic?.newsworthiness_score || 0,
    publish_priority: article?.summary?.publish_priority || article?.topic?.publish_priority || "",
    selection_reason: article?.topic?.selection_reason || "",
    source_mix: article?.topic?.source_mix || {}
  };
}

async function appendFeedback(dataDir: string, records: ReviewFeedback[]) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(path.join(dataDir, "review-feedback.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

async function findReviewPath(dataDir: string, issueNumber: number, requestedDate?: string, requestedManualCommentId?: string): Promise<{ reviewPath: string; commentId?: string }> {
  if (requestedManualCommentId || process.env.MANUAL_REVIEW === "true") {
    const located = await findManualReviewPath(dataDir, issueNumber, requestedManualCommentId);
    return located;
  }
  if (requestedDate) return { reviewPath: path.join(dataDir, requestedDate, "review.json") };
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const candidate = path.join(dataDir, entry.name, "review.json");
    try {
      const state = await readReviewState(candidate);
      if (!issueNumber || state.issue_number === issueNumber) return { reviewPath: candidate };
    } catch {
      // 別形式のディレクトリは無視する。
    }
  }
  throw new Error(`review.json not found for issue #${issueNumber}`);
}

async function postReplies(issueNumber: number, replies: string[]) {
  if (!issueNumber) return;
  for (const reply of replies) execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", reply], { stdio: "inherit" });
}

function buildCompletionSummary(state: ReviewState) {
  const approved = state.articles.filter((article) => article.status === "approved").length;
  const rejected = state.articles.filter((article) => article.status === "rejected");
  const revisions = state.articles.reduce((sum, article) => sum + article.revision_count, 0);
  const tags = new Map<string, number>();
  rejected.forEach((article) => tags.set(article.reason_tag || "その他", (tags.get(article.reason_tag || "その他") || 0) + 1));
  return `✅ レビュー完了: 採用${approved}本・修正${revisions}回・却下${rejected.length}本${tags.size ? `（${[...tags].map(([tag, count]) => `${tag}${count}`).join("、")}）` : ""}`;
}

main().catch((error) => {
  console.error(`review apply failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
