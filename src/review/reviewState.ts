import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveSummaryTitle } from "../summaryTitle.js";
import { getPublishableArticles } from "../renderMarkdown.js";
import type { ProcessedArticle, ReviewState, ReviewStatus } from "../types.js";

export function createReviewState(articles: ProcessedArticle[], date = today()): ReviewState {
  const publishable = getPublishableArticles(articles);
  return createReviewStateFromOrderedArticles(publishable, date);
}

export function createReviewStateFromStoredArticles(articles: ProcessedArticle[], date: string): ReviewState {
  if (articles.some((article) => !article.summary)) {
    throw new Error(`Cannot bootstrap review.json: stored articles for ${date} contain unpublished entries`);
  }
  return createReviewStateFromOrderedArticles(articles, date);
}

function createReviewStateFromOrderedArticles(articles: ProcessedArticle[], date: string): ReviewState {
  return {
    date,
    status: "pending",
    issue_number: 0,
    articles: articles.map((article, position) => {
      const index = position + 1;
      const topicKey = article.summary?.topic_key || article.topic?.topic_key || article.raw.topicKey || "";
      return {
        index,
        topic_key: topicKey,
        title: resolveSummaryTitle(article.summary?.title_ja || "", article.raw.title),
        status: "pending",
        reason_tag: "",
        comment: "",
        revision_count: 0,
        article_id: stableArticleId(date, topicKey, index),
        current_version: 1,
        publication: { slug: String(index) }
      };
    })
  };
}

export async function readOrCreateStoredReviewState(filePath: string, articles: ProcessedArticle[], date: string) {
  try {
    return { state: await readReviewState(filePath), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = createReviewStateFromStoredArticles(articles, date);
    await writeReviewState(filePath, state);
    return { state, created: true };
  }
}

export async function writeInitialReviewState(articles: ProcessedArticle[], date = today(), outputDir = "output") {
  const outputPath = path.resolve(outputDir, `review_${date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await writeReviewState(outputPath, createReviewState(articles, date));
  return outputPath;
}

export async function readReviewState(filePath: string): Promise<ReviewState> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ReviewState;
  if (!parsed || !Array.isArray(parsed.articles) || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    throw new Error(`Invalid review state: ${filePath}`);
  }
  return normalizeReviewState(parsed);
}

export async function writeReviewState(filePath: string, state: ReviewState) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalizeReviewState(state), null, 2)}\n`, "utf8");
}

/**
 * Backward-compatible migration for review JSON written before revisions and
 * per-article publication existed.  The old public URL used the position among
 * approved articles, so completed historical days must retain that ordering.
 */
export function normalizeReviewState(state: ReviewState): ReviewState {
  // Only a wholly pre-revision record can be inferred as already published.
  // New reviews are normalized while still pending; when their last article is
  // approved later, they must still require a deploy instead of being silently
  // treated as an old completed publication.
  const isLegacyCompletedReview = state.status === "completed" && state.articles.every((article) =>
    !article.article_id && article.current_version === undefined && article.publication === undefined
  );
  let approvedPosition = 0;
  return {
    ...state,
    articles: state.articles.map((article) => {
      const legacySlug = isLegacyCompletedReview && article.status === "approved"
        ? String(++approvedPosition)
        : isLegacyCompletedReview ? `u-${article.index}` : String(article.index);
      const legacyPublished = isLegacyCompletedReview && article.status === "approved";
      return {
        ...article,
        article_id: article.article_id || stableArticleId(state.date, article.topic_key, article.index),
        current_version: article.current_version ?? 1,
        publication: {
          slug: article.publication?.slug || legacySlug,
          ...(article.publication?.queued_at ? { queued_at: article.publication.queued_at } : {}),
          ...(article.publication?.published_at ? { published_at: article.publication.published_at } : legacyPublished ? { published_at: `${state.date}T00:00:00+08:00` } : {}),
          ...(article.publication?.published_version !== undefined ? { published_version: article.publication.published_version } : legacyPublished ? { published_version: 1 } : {}),
          ...(article.publication?.updated_at ? { updated_at: article.publication.updated_at } : {}),
          ...(article.publication?.x_pending_at ? { x_pending_at: article.publication.x_pending_at } : {}),
          ...(article.publication?.x_post_attempt_id ? { x_post_attempt_id: article.publication.x_post_attempt_id } : {}),
          ...(article.publication?.x_post_attempted_at ? { x_post_attempted_at: article.publication.x_post_attempted_at } : {}),
          ...(article.publication?.x_posted_at ? { x_posted_at: article.publication.x_posted_at } : {})
        }
      };
    })
  };
}

export function stableArticleId(date: string, topicKey: string, index: number) {
  return `a-${createHash("sha256").update(`${date}\u0000${topicKey}\u0000${index}`).digest("hex").slice(0, 16)}`;
}

export function deriveReviewStatus(articles: ReviewState["articles"]): ReviewStatus {
  return articles.length > 0 && articles.every((article) => article.status === "approved" || article.status === "rejected" || article.status === "held")
    ? "completed"
    : "pending";
}

/** An approved article needs a build only when its current immutable version is not yet published. */
export function hasPublishRequired(articles: ReviewState["articles"]) {
  return articles.some((article) => article.status === "approved" && (!article.publication?.published_at || article.publication.published_version !== article.current_version));
}

/**
 * The first approved version is queued before the deployment starts so a
 * delayed article can be sorted by its actual public-release attempt.  Never
 * refresh it for corrections: published_at remains the permanent first-public
 * timestamp and queued_at remains the original queue timestamp.
 */
export function queueApprovedArticlesForPublication(articles: ReviewState["articles"], queuedAt: string) {
  for (const article of articles) {
    if (article.status !== "approved" || article.publication?.published_at || article.publication?.queued_at) continue;
    article.publication = {
      ...article.publication,
      slug: article.publication?.slug || String(article.index),
      queued_at: queuedAt
    };
  }
}

/** First-publication X posts are durable work items, not a transient workflow artifact. */
export function hasXPostRequired(articles: ReviewState["articles"]) {
  return articles.some((article) => Boolean(article.publication?.x_pending_at && !article.publication.x_posted_at && !article.publication.x_post_attempt_id));
}

/** An API outcome is uncertain after its attempt marker was committed; never auto-retry it. */
export function hasUncertainXPost(articles: ReviewState["articles"]) {
  return articles.some((article) => Boolean(article.publication?.x_pending_at && !article.publication.x_posted_at && article.publication.x_post_attempt_id));
}

export function isReviewGateEnabled() {
  return process.env.REVIEW_GATE !== "false";
}

export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
