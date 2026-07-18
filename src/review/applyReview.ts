import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatReviewArticle } from "./buildReviewIssueBody.js";
import { parseReviewComment, type ReviewDecision } from "./parseReviewComment.js";
import { readReviewState, writeReviewState } from "./reviewState.js";
import { reviseStoredArticle } from "./reviseArticle.js";
import type { ProcessedArticle, ReviewArticle, ReviewFeedback, ReviewState } from "../types.js";

async function main() {
  if (process.env.REVIEW_GATE === "false") return;
  const body = process.env.REVIEW_COMMENT || process.env.COMMENT_BODY || "";
  if (!body.trim()) throw new Error("REVIEW_COMMENT is required");
  const issueNumber = Number(process.env.REVIEW_ISSUE_NUMBER || process.env.ISSUE_NUMBER || 0);
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const reviewPath = await findReviewPath(dataDir, issueNumber, process.env.REVIEW_DATE);
  const directory = path.dirname(reviewPath);
  const state = await readReviewState(reviewPath);
  const parsed = parseReviewComment(body);
  const feedback: ReviewFeedback[] = [];
  const replies: string[] = [];

  for (const decision of parsed.decisions) {
    const targets = selectTargets(state, decision);
    if (!targets.length && decision.index !== undefined) {
      parsed.invalidLines.push(`${decision.index}: 記事番号がありません`);
      continue;
    }
    for (const target of targets) {
      if (decision.action === "approved" || decision.action === "remaining_approved") {
        setDecision(target, "approved", "", "");
        continue;
      }
      if (decision.action === "rejected" || decision.action === "remaining_rejected") {
        setDecision(target, "rejected", decision.reasonTag, decision.comment);
        feedback.push(await buildFeedback(directory, state.date, target, "rejected"));
        continue;
      }
      if (target.revision_count >= 3) {
        target.status = "revised_pending";
        replies.push(`⚠️ ${target.index}番は修正上限3回に達しています。採用または却下を判定してください。`);
        continue;
      }
      setDecision(target, "revision_requested", decision.reasonTag, decision.comment);
      feedback.push(await buildFeedback(directory, state.date, target, "revision_requested"));
      try {
        const revised = await reviseStoredArticle(directory, target.index, decision.comment, decision.reasonTag);
        target.revision_count += 1;
        target.status = "revised_pending";
        target.title = revised.summary?.title_ja || target.title;
        replies.push(formatReviewArticle(target.index, revised, true));
      } catch (error) {
        target.status = "pending";
        replies.push(`⚠️ ${target.index}番の再生成に失敗しました。元の記事を維持して未判定に戻します。\n\n${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  state.status = state.articles.every((article) => article.status === "approved" || article.status === "rejected") ? "completed" : "pending";
  await writeReviewState(reviewPath, state);
  if (feedback.length) await appendFeedback(dataDir, feedback);
  if (parsed.invalidLines.length) replies.push(`⚠️ 解釈できなかった行\n\n${parsed.invalidLines.map((line) => `- ${line}`).join("\n")}`);
  if (state.status === "completed") replies.push(buildCompletionSummary(state));
  await postReplies(issueNumber || state.issue_number, replies);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `completed=${state.status === "completed"}\ndate=${state.date}\n`, "utf8");
  }
  console.log(`review apply: ${state.date} / ${state.status}`);
}

function selectTargets(state: ReviewState, decision: ReviewDecision) {
  if (decision.action === "remaining_approved" || decision.action === "remaining_rejected") {
    return state.articles.filter((article) => article.status === "pending" || article.status === "revised_pending");
  }
  return state.articles.filter((article) => article.index === decision.index);
}

function setDecision(article: ReviewArticle, status: "approved" | "rejected" | "revision_requested", reasonTag: ReviewArticle["reason_tag"], comment: string) {
  article.status = status;
  article.reason_tag = reasonTag;
  article.comment = comment;
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

async function findReviewPath(dataDir: string, issueNumber: number, requestedDate?: string) {
  if (requestedDate) return path.join(dataDir, requestedDate, "review.json");
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const candidate = path.join(dataDir, entry.name, "review.json");
    try {
      const state = await readReviewState(candidate);
      if (!issueNumber || state.issue_number === issueNumber) return candidate;
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
