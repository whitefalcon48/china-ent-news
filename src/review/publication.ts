import fs from "node:fs/promises";
import path from "node:path";
import { readReviewState } from "./reviewState.js";
import type { ProcessedArticle, ReviewState, SummarizedArticle } from "../types.js";

/**
 * Publication is deliberately kept outside the review decision itself.  A
 * review may be open while an earlier, already published version stays live.
 * The structural types below also make pre-migration review.json readable.
 */
export type PublicationRecord = {
  slug?: string;
  published_at?: string;
  published_version?: number;
  updated_at?: string;
  queued_at?: string;
  x_pending_at?: string;
  x_post_attempt_id?: string;
  x_post_attempted_at?: string;
  x_posted_at?: string;
};

export type PublicationReviewArticle = ReviewState["articles"][number] & {
  article_id?: string;
  current_version?: number;
  pending_proposal_id?: string;
  publication?: PublicationRecord;
};

export type PublicationReviewState = Omit<ReviewState, "articles"> & {
  articles: PublicationReviewArticle[];
};

type RevisionVersion = { n?: unknown; summary?: unknown; article_summary?: unknown };
type RevisionEntry = { current_version?: unknown; versions?: unknown };
type RevisionFile = { articles?: Record<string, RevisionEntry> };

export type PublicationCandidate = {
  article: ProcessedArticle;
  review: PublicationReviewArticle;
  articleId: string;
  slug: string;
  currentVersion: number;
  displayedVersion: number;
  isCurrentVersion: boolean;
};

export async function readPublicationReview(directory: string): Promise<PublicationReviewState | null> {
  try {
    // reviewState owns legacy normalization (stable IDs and legacy slugs).
    return await readReviewState(path.join(directory, "review.json")) as PublicationReviewState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRevisionFile(directory: string): Promise<RevisionFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, "revisions.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${directory}/revisions.json: JSON object is required`);
    return parsed as RevisionFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function articleIdFor(review: PublicationReviewState, article: PublicationReviewArticle) {
  return article.article_id || `${review.date}:${article.index}`;
}

export function currentVersionFor(article: PublicationReviewArticle, revisions: RevisionFile | null, articleId: string) {
  const own = positiveInteger(article.current_version);
  if (own) return own;
  const stored = positiveInteger(revisions?.articles?.[articleId]?.current_version);
  return stored || 1;
}

/**
 * A legacy completed review was already deployed using its position within
 * approved articles.  Preserve that historical URL until publication.slug is
 * written.  An unfinished legacy review has never been published, so its
 * review index is safe and stable.
 */
export function slugFor(review: PublicationReviewState, article: PublicationReviewArticle) {
  const stored = article.publication?.slug?.trim();
  if (stored) return stored;
  if (review.status === "completed") {
    const rank = review.articles.filter((item) => item.status === "approved").findIndex((item) => item.index === article.index);
    if (rank >= 0) return String(rank + 1);
  }
  return String(article.index);
}

/**
 * Standard builds render only versions recorded after a successful deploy.
 * review-apply opts into queued versions only for the deployment it is about
 * to perform; this keeps an ordinary main push from publishing a draft.
 */
export async function selectPublicationCandidates(
  directory: string,
  articles: ProcessedArticle[],
  options: { includeQueued?: boolean } = {}
): Promise<PublicationCandidate[] | null> {
  const review = await readPublicationReview(directory);
  if (!review) return null;
  const revisions = await readRevisionFile(directory);
  const selected: PublicationCandidate[] = [];

  for (const reviewArticle of review.articles) {
    const baseArticle = articles[reviewArticle.index - 1];
    if (!baseArticle?.summary) continue;
    const articleId = articleIdFor(review, reviewArticle);
    const currentVersion = currentVersionFor(reviewArticle, revisions, articleId);
    const publishedVersion = positiveInteger(reviewArticle.publication?.published_version);
    const hasPublishedVersion = Boolean(reviewArticle.publication?.published_at && publishedVersion);
    const stageCurrentVersion = options.includeQueued === true && reviewArticle.status === "approved";
    if (!stageCurrentVersion && !hasPublishedVersion) continue;

    // A re-approved version is what the just-started deployment must render.
    // Otherwise an unresolved proposal continues to show the last published
    // version.  Missing legacy snapshots fall back to the stored article.
    const displayedVersion = stageCurrentVersion ? currentVersion : publishedVersion!;
    const summary = summaryForVersion(revisions, articleId, displayedVersion) ?? baseArticle.summary;
    selected.push({
      article: { ...baseArticle, summary },
      review: reviewArticle,
      articleId,
      slug: slugFor(review, reviewArticle),
      currentVersion,
      displayedVersion,
      isCurrentVersion: displayedVersion === currentVersion
    });
  }
  return selected;
}

export function summaryForVersion(revisions: RevisionFile | null, articleId: string, version: number): SummarizedArticle | null {
  const versions = revisions?.articles?.[articleId]?.versions;
  if (!Array.isArray(versions)) return null;
  const found = versions.find((item) => isRecord(item) && positiveInteger(item.n) === version);
  if (!isRecord(found)) return null;
  // `article_summary` is the revision-store field. `summary` is accepted for
  // the early design fixture and keeps hand-written migration data readable.
  const stored = found.article_summary ?? found.summary;
  return isSummary(stored) ? stored : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function isSummary(value: unknown): value is SummarizedArticle {
  return isRecord(value) && typeof value.title_ja === "string";
}
