import type { ReviewReasonTag } from "../types.js";

export type UiReviewDecision = {
  index?: number;
  action: "approved" | "rejected" | "revision_requested" | "remaining_approved" | "remaining_rejected";
  reasonTag?: Exclude<ReviewReasonTag, "">;
  comment?: string;
};

export function buildReviewComment(decisions: UiReviewDecision[]) {
  return decisions.map((decision) => {
    if (decision.action === "remaining_approved") return "残り採用";
    if (decision.action === "remaining_rejected") return joinParts("残り却下", decision.reasonTag, decision.comment);
    if (!Number.isInteger(decision.index) || (decision.index || 0) < 1) throw new Error("記事番号が不正です");
    if (decision.action === "approved") return `${decision.index} 採用`;
    const action = decision.action === "rejected" ? "却下" : "修正";
    return joinParts(`${decision.index} ${action}`, decision.reasonTag, decision.comment);
  }).join("\n");
}

function joinParts(prefix: string, reasonTag?: string, comment?: string) {
  return [prefix, reasonTag, comment?.trim()].filter(Boolean).join(" ");
}
