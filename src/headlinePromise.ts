import type { SummarizedArticle } from "./types.js";

type HeadlinePromiseInput = Pick<
  SummarizedArticle,
  "title_ja" | "lead" | "what_happened" | "detail_sections"
>;

export type HeadlinePromiseFailure = {
  title: string;
  detail: string;
};

// These headlines promise that the article will answer a question, not merely
// report that somebody answered it elsewhere.
const ANSWER_PROMISE = /(?:意味|由来|理由|背景|真相|狙い).{0,18}(?:解説|説明|明か|語る|判明|公開)|(?:なぜ|どうして).{0,24}(?:解説|説明|明か)/u;

// A concrete answer defines, attributes, contrasts, or gives a cause. Generic
// sentences such as "タイトルの意味が解説された" match none of these.
const CONCRETE_ANSWER = /(?:とは|(?:と|の)いう意味|を意味|に由来|から名付け|を表す|を示す|を象徴|を指す|に重ね|という願い|という思い|理由は|背景には|真相は|狙いは|(?:ため|から)だと(?:説明|明かし|語っ))/u;
const QUOTED_ANSWER = /「[^」]{2,}」.{0,36}(?:意味|由来|願い|思い|表す|象徴|指す)/u;

export function findUnfulfilledHeadlinePromise(summary: HeadlinePromiseInput): HeadlinePromiseFailure | null {
  const title = summary.title_ja.trim();
  if (!title || !ANSWER_PROMISE.test(title)) return null;

  const body = [
    summary.lead,
    summary.what_happened,
    ...(summary.detail_sections ?? []).flatMap((section) => [section.heading, section.body])
  ].join("\n");
  if (CONCRETE_ANSWER.test(body) || QUOTED_ANSWER.test(body)) return null;

  return {
    title,
    detail: `見出しが答えを約束していますが、本文に意味・理由・由来・背景の具体的な説明がありません: ${title}`
  };
}

export function assertHeadlinePromiseFulfilled(summary: HeadlinePromiseInput) {
  const failure = findUnfulfilledHeadlinePromise(summary);
  if (failure) throw new Error(`headline_promise_unfulfilled:${failure.detail}`);
}
