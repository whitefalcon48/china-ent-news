import path from "node:path";
import { pathToFileURL } from "node:url";
import { readReviewState, writeReviewState } from "../review/reviewState.js";
import { getManualIntakeDirectory, readManualIntakeState, updateManualIntakeState } from "./intakeState.js";

type LinkResult =
  | { ok: true; idempotent: boolean; commentId: string; issueNumber: number }
  | { ok: false; commentId: string; error: string };

export async function linkManualReviewIssue(input: {
  commentId: string;
  issueNumber: number;
  issueUrl: string;
  dataRoot?: string;
}): Promise<LinkResult> {
  if (!/^\d+$/u.test(input.commentId)) return { ok: false, commentId: input.commentId, error: "invalid_comment_id" };
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) return { ok: false, commentId: input.commentId, error: "invalid_issue_number" };
  if (!isMatchingIssueUrl(input.issueUrl, input.issueNumber)) return { ok: false, commentId: input.commentId, error: "issue_url_number_mismatch" };
  const dataRoot = input.dataRoot ?? "data";
  const state = await readManualIntakeState(input.commentId, dataRoot);
  if (!state) return { ok: false, commentId: input.commentId, error: "intake_state_not_found" };
  if (state.status !== "review_ready") return { ok: false, commentId: input.commentId, error: `invalid_intake_status:${state.status}` };
  if (state.review_issue_number && state.review_issue_number !== input.issueNumber) {
    return { ok: false, commentId: input.commentId, error: `review_issue_already_linked:${state.review_issue_number}` };
  }
  const reviewPath = path.join(getManualIntakeDirectory(input.commentId, dataRoot), "review.json");
  const review = await readReviewState(reviewPath);
  if (review.issue_number && review.issue_number !== input.issueNumber) {
    return { ok: false, commentId: input.commentId, error: `review_state_already_linked:${review.issue_number}` };
  }
  const idempotent = review.issue_number === input.issueNumber && state.review_issue_number === input.issueNumber;
  if (!idempotent) {
    await writeReviewState(reviewPath, { ...review, issue_number: input.issueNumber });
    await updateManualIntakeState(state, { status: "review_ready", review_issue_number: input.issueNumber }, dataRoot);
  }
  return { ok: true, idempotent, commentId: input.commentId, issueNumber: input.issueNumber };
}

export async function runLinkManualReviewIssueCli(env: Record<string, string | undefined> = process.env) {
  const commentId = (env.MANUAL_COMMENT_ID || "").trim();
  const issueNumber = Number(env.REVIEW_ISSUE_NUMBER || 0);
  return linkManualReviewIssue({
    commentId,
    issueNumber,
    issueUrl: env.REVIEW_ISSUE_URL || "",
    dataRoot: env.SITE_DATA_DIR || "data"
  });
}

function isMatchingIssueUrl(value: string, issueNumber: number) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && new RegExp(`/issues/${issueNumber}/?$`, "u").test(url.pathname);
  } catch {
    return false;
  }
}

async function main() {
  const result = await runLinkManualReviewIssueCli();
  console.log(`manual review link: comment ${result.commentId || "unknown"} / ${result.ok ? `issue ${result.issueNumber}` : "failed"}`);
  if (!result.ok) {
    console.warn(`manual review link error: ${result.error.replace(/[\r\n]+/gu, " ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.warn(`manual review link fatal: ${error instanceof Error ? error.message.replace(/[\r\n]+/gu, " ") : "unknown_error"}`);
    process.exitCode = 1;
  });
}
