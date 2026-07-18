import fs from "node:fs/promises";
import path from "node:path";
import { resolveSummaryTitle } from "../summaryTitle.js";
import { getPublishableArticles } from "../renderMarkdown.js";
import type { ProcessedArticle, ReviewState } from "../types.js";

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
    articles: articles.map((article, position) => ({
      index: position + 1,
      topic_key: article.summary?.topic_key || article.topic?.topic_key || article.raw.topicKey || "",
      title: resolveSummaryTitle(article.summary?.title_ja || "", article.raw.title),
      status: "pending",
      reason_tag: "",
      comment: "",
      revision_count: 0
    }))
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
  return parsed;
}

export async function writeReviewState(filePath: string, state: ReviewState) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
