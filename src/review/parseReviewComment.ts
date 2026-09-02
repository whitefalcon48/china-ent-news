import type { ReviewReasonTag } from "../types.js";

export type ReviewDecision = {
  index?: number;
  action: "approved" | "rejected" | "held" | "revision_requested" | "proposal_apply" | "proposal_apply_approve" | "proposal_discard" | "revert_initial" | "revert_previous" | "remaining_approved" | "remaining_rejected" | "rescue_rebuild";
  reasonTag: ReviewReasonTag;
  comment: string;
};

export type ParsedReviewComment = { decisions: ReviewDecision[]; invalidLines: string[] };

const TAG = "(選定|口調|用語|事実|構成|その他)";
const DECISION_RE = new RegExp(`^(\\d+)[\\s　]+(採用|却下|保留|修正)(?:[\\s　]+${TAG})?(?:[\\s　]+(.*))?$`, "u");
const REMAINING_REJECT_RE = new RegExp(`^残り却下(?:[\\s　]+${TAG})?(?:[\\s　]+(.*))?$`, "u");
const NUMBERED_RE = /^(\d+)[\s　]+(.*)$/u;

/** A numbered instruction may span multiple lines without exposing parser syntax. */
export function parseReviewComment(body: string): ParsedReviewComment {
  const decisions: ReviewDecision[] = [];
  const invalidLines: string[] = [];
  const blocks: Array<{ first: string; continuation: string[] }> = [];
  let current: { first: string; continuation: string[] } | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripListPrefix(rawLine.trim());
    if (!line) continue;
    if (NUMBERED_RE.test(line) || isStandalone(line)) {
      current = { first: line, continuation: [] };
      blocks.push(current);
    } else if (current) {
      current.continuation.push(line);
    } else invalidLines.push(line);
  }

  for (const block of blocks) {
    const line = block.first;
    if (line === "救済再生成") {
      decisions.push({ action: "rescue_rebuild", reasonTag: "", comment: "" });
      continue;
    }
    if (line === "残り採用" || line === "全部採用") {
      decisions.push({ action: "remaining_approved", reasonTag: "その他", comment: "" });
      continue;
    }
    const remainingReject = line.match(REMAINING_REJECT_RE);
    if (remainingReject) {
      decisions.push({ action: "remaining_rejected", reasonTag: asReasonTag(remainingReject[1]), comment: joinComment(remainingReject[2], block.continuation) });
      continue;
    }
    const numbered = line.match(NUMBERED_RE);
    if (!numbered) {
      invalidLines.push([line, ...block.continuation].join("\n"));
      continue;
    }
    const index = Number(numbered[1]);
    const command = numbered[2].trim();
    if (/^適用[\s　]+採用$/u.test(command)) decisions.push({ index, action: "proposal_apply_approve", reasonTag: "", comment: "" });
    else if (command === "適用") decisions.push({ index, action: "proposal_apply", reasonTag: "", comment: "" });
    else if (command === "やめる") decisions.push({ index, action: "proposal_discard", reasonTag: "", comment: "" });
    else if (command === "初版に戻す") decisions.push({ index, action: "revert_initial", reasonTag: "", comment: "" });
    else if (command === "戻す" || command === "一つ前に戻す") decisions.push({ index, action: "revert_previous", reasonTag: "", comment: "" });
    else {
      const decision = line.match(DECISION_RE);
      if (decision) {
        decisions.push({
          index,
          action: decision[2] === "採用" ? "approved" : decision[2] === "却下" ? "rejected" : decision[2] === "保留" ? "held" : "revision_requested",
          reasonTag: asReasonTag(decision[3]),
          comment: joinComment(decision[4], block.continuation)
        });
      } else {
        // Numbered free text is a revision request; reason tags remain optional.
        decisions.push({ index, action: "revision_requested", reasonTag: "その他", comment: [command, ...block.continuation].join("\n") });
      }
    }
  }
  return { decisions, invalidLines };
}

function isStandalone(line: string) {
  return line === "救済再生成" || line === "残り採用" || line === "全部採用" || line.startsWith("残り却下");
}

function stripListPrefix(line: string) {
  return line.replace(/^(?:[-*•・][\s　]*)/u, "");
}

function joinComment(first: string | undefined, continuation: string[]) {
  return [first?.trim(), ...continuation].filter(Boolean).join("\n");
}

function asReasonTag(value?: string): Exclude<ReviewReasonTag, ""> {
  return (value || "その他") as Exclude<ReviewReasonTag, "">;
}
