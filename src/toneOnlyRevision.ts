import type { SummarizedArticle } from "./types.js";

/** A tone review is never allowed to become a new editorial pass. */
export class ToneOnlyRevisionContractError extends Error {
  constructor(detail: string) {
    super(`口調のみの修正として確認できませんでした: ${detail}。元の記事は変更していません。内容も変える修正として、別の理由タグで改めて依頼してください。`);
    this.name = "ToneOnlyRevisionContractError";
  }
}

export function assertToneOnlyRevisionContract(before: SummarizedArticle, after: SummarizedArticle) {
  if (!sameClaimRefs(before.claim_refs.why_it_matters, after.claim_refs.why_it_matters)) {
    throw new ToneOnlyRevisionContractError("注目ポイントの claim refs が変わりました");
  }
  if (!sameSummaryExceptWhyItMatters(before, after)) {
    throw new ToneOnlyRevisionContractError("注目ポイント以外の本文またはメタデータが変わりました");
  }
  if (toneOnlySkeleton(before.why_it_matters) !== toneOnlySkeleton(after.why_it_matters)) {
    throw new ToneOnlyRevisionContractError("事実・注目対象・評価軸を表す語句が変わりました");
  }
}

export function toneOnlySkeleton(value: string) {
  return value
    .split(/[。！？!?\n]+/u)
    .map((sentence) => stripSentenceEnding(sentence.replace(/[\s「」『』“”"'、，,・…—―]/gu, "")))
    .join("");
}

function stripSentenceEnding(value: string) {
  let result = value;
  const ending = /(?:でした|ました|ません|ましょう|でしょうか|でしょう|ですよね|ですよ|ですね|ですか|だよね|だよ|だね|だった|です|ます|だ|よね|かも|かな|よ|ね|な|ぞ|わ)$/u;
  while (ending.test(result)) result = result.replace(ending, "");
  return result;
}

function sameClaimRefs(before: string[], after: string[]) {
  return before.length === after.length && before.every((ref, index) => ref === after[index]);
}

function sameSummaryExceptWhyItMatters(before: SummarizedArticle, after: SummarizedArticle) {
  const beforeCopy = { ...before, why_it_matters: "" };
  const afterCopy = { ...after, why_it_matters: "" };
  return JSON.stringify(beforeCopy) === JSON.stringify(afterCopy);
}
