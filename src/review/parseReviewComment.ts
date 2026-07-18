import type { ReviewReasonTag } from "../types.js";

export type ReviewDecision = {
  index?: number;
  action: "approved" | "rejected" | "revision_requested" | "remaining_approved" | "remaining_rejected";
  reasonTag: Exclude<ReviewReasonTag, "">;
  comment: string;
};

export type ParsedReviewComment = { decisions: ReviewDecision[]; invalidLines: string[] };

const DECISION_RE = /^(\d+)[\s　]+(採用|却下|修正)(?:[\s　]+(選定|口調|用語|事実|構成|その他))?(?:[\s　]+(.*))?$/;
const REMAINING_REJECT_RE = /^残り却下(?:[\s　]+(選定|口調|用語|事実|構成|その他))?(?:[\s　]+(.*))?$/;

export function parseReviewComment(body: string): ParsedReviewComment {
  const decisions: ReviewDecision[] = [];
  const invalidLines: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "残り採用" || line === "全部採用") {
      decisions.push({ action: "remaining_approved", reasonTag: "その他", comment: "" });
      continue;
    }
    const remainingReject = line.match(REMAINING_REJECT_RE);
    if (remainingReject) {
      decisions.push({ action: "remaining_rejected", reasonTag: asReasonTag(remainingReject[1]), comment: remainingReject[2]?.trim() || "" });
      continue;
    }
    const match = line.match(DECISION_RE);
    if (!match) {
      invalidLines.push(line);
      continue;
    }
    decisions.push({
      index: Number(match[1]),
      action: match[2] === "採用" ? "approved" : match[2] === "却下" ? "rejected" : "revision_requested",
      reasonTag: asReasonTag(match[3]),
      comment: match[4]?.trim() || ""
    });
  }
  return { decisions, invalidLines };
}

function asReasonTag(value?: string): Exclude<ReviewReasonTag, ""> {
  return (value || "その他") as Exclude<ReviewReasonTag, "">;
}
