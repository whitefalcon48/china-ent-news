/** Input contract for the permanent manual-news Issue.
 * One OWNER comment must contain exactly one http(s) URL and may contain an
 * optional note explaining why it is urgent. */
export type ManualIntakeComment = {
  id: number | string;
  body: string;
  authorLogin: string;
  authorAssociation?: string;
};

export type ParsedManualIntake = {
  accepted: boolean;
  commentId: string;
  url?: string;
  note: string;
  error?: "not_owner" | "expected_exactly_one_url" | "invalid_url";
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;

export function parseManualIntake(comment: ManualIntakeComment): ParsedManualIntake {
  const commentId = String(comment.id);
  if (comment.authorAssociation !== "OWNER") {
    return { accepted: false, commentId, note: "", error: "not_owner" };
  }

  const candidates = [...comment.body.matchAll(URL_PATTERN)]
    .map((match) => trimTrailingPunctuation(match[0]))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  if (candidates.length !== 1) {
    return { accepted: false, commentId, note: "", error: "expected_exactly_one_url" };
  }

  try {
    const parsed = new URL(candidates[0]);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
      return { accepted: false, commentId, note: "", error: "invalid_url" };
    }
    const note = comment.body.replace(candidates[0], "").replace(/^[\s\-–—:：]+|[\s\-–—:：]+$/gu, "").trim();
    return { accepted: true, commentId, url: parsed.toString(), note };
  } catch {
    return { accepted: false, commentId, note: "", error: "invalid_url" };
  }
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[),.。、】【】]+$/gu, "");
}
