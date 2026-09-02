import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getPublishableArticles } from "../renderMarkdown.js";
import { articleIdFor, readPublicationReview, selectPublicationCandidates, type PublicationCandidate, type PublicationReviewState } from "../review/publication.js";
import type { ProcessedArticle, SummarizedArticle } from "../types.js";
import { MAX_WEIGHTED_LENGTH, buildDailyDigest, buildIndividualPosts, buildPostsMarkdown, xWeightedLength } from "./xPostTexts.js";

const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
const requestedDate = process.env.POST_DATE;
const siteUrl = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.SITE_BASE_PATH || "");
const live = process.env.X_POST_LIVE === "true";
// A committed attempt marker may represent a successful API call whose receipt
// never reached git.  Only the same workflow invocation, or an operator who
// explicitly opts in after checking X, may send it.
const confirmedAttempt = process.env.X_POST_ATTEMPT_CONFIRMED === "true" || process.env.X_RETRY_UNCERTAIN === "true";

const date = requestedDate || await findLatestDate();
const selection = await loadArticles(date);
const selected = selection.articles;
const articles = selected.map((item) => item.article);
if (!articles.length) {
  console.log("X post: this publication batch has no unposted articles");
  await writeNoPostTexts(date);
  process.exit(0);
}
const text = buildDailyDigest(selection.displayDate || date, articles, siteUrl, basePath, date);
if (xWeightedLength(text) > MAX_WEIGHTED_LENGTH) throw new Error(`X文面が上限280（X換算）を超えています: ${xWeightedLength(text)}`);

console.log(`X digest (${xWeightedLength(text)}/${MAX_WEIGHTED_LENGTH} X換算):\n${text}`);
if (!live) {
  console.log("X dry-run: X_POST_LIVE=true ではないため投稿しません");
  await writePostTexts(date, text, articles);
} else {
  await postTweet(text);
  await markXPosted(date, selected);
  console.log("X post: success");
}

async function findLatestDate() {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const dates = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map((entry) => entry.name).sort();
  const latest = dates.at(-1);
  if (!latest) throw new Error("X投稿用の日次データがありません");
  return latest;
}

type XArticle = { article: ProcessedArticle; articleId?: string; review?: PublicationCandidate["review"] };
type XSelection = { articles: XArticle[]; displayDate?: string };

async function loadArticles(dateValue: string): Promise<XSelection> {
  const filename = path.join(dataDir, dateValue, `articles_${dateValue}.json`);
  const raw = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${filename}: JSONルートは配列である必要があります`);
  const articles = raw.map((value) => normalizeArticle(value));
  if (process.env.REVIEW_GATE === "false") return { articles: getPublishableArticles(articles).map((article) => ({ article })) };
  const selected = await selectPublicationCandidates(path.join(dataDir, dateValue), articles);
  if (selected === null) return { articles: getPublishableArticles(articles).map((article) => ({ article })) };
  const batch = await readPublicationBatch(dateValue);
  const allowReannouncement = process.env.X_REANNOUNCE === "true";
  // A review-gated retry must never rediscover all historical articles as a
  // post queue.  The deploy-produced batch is the authority; an operator can
  // intentionally opt into a reannouncement when there is no batch.
  if (!batch && !allowReannouncement) {
    // publication_batch is an Action artifact, not durable state.  A failed
    // X step on a later retry still has the committed first-publication queue.
    return {
      articles: selected
        .filter((item) => Boolean(item.review.publication?.x_pending_at && !item.review.publication?.x_posted_at))
        .filter((item) => !live || Boolean(item.review.publication?.x_post_attempt_id && confirmedAttempt))
        .map((item) => ({ article: item.article, articleId: item.articleId, review: item.review })),
      displayDate: publicationDateFromTimestamp(selected.find((item) => item.review.publication?.x_pending_at)?.review.publication?.x_pending_at)
    };
  }
  const batchIds = batch
    ? new Set(batch.articles.filter((item) => allowReannouncement || item.first_publication).map((item) => item.article_id))
    : null;
  return {
    articles: selected
      .filter((item) => !batchIds || batchIds.has(item.articleId))
      .filter((item) => allowReannouncement || !item.review.publication?.x_posted_at)
      .filter((item) => !live || allowReannouncement || Boolean(item.review.publication?.x_post_attempt_id && confirmedAttempt))
      .map((item) => ({ article: item.article, articleId: item.articleId, review: item.review })),
    // A correction is not in the normal automatic queue, so this timestamp
    // only changes the date shown for a first-publication batch.
    displayDate: publicationDateFromTimestamp(batch?.recorded_at)
  };
}

type PublicationBatch = { date?: string; recorded_at?: string; articles?: Array<{ article_id?: string; first_publication?: boolean }> };

async function readPublicationBatch(dateValue: string): Promise<{ recorded_at?: string; articles: Array<{ article_id: string; first_publication: boolean }> } | null> {
  const outputDir = path.resolve(process.env.SITE_OUTPUT_DIR || "output");
  try {
    const value = JSON.parse(await fs.readFile(path.join(outputDir, `publication_batch_${dateValue}.json`), "utf8")) as PublicationBatch;
    if (!Array.isArray(value.articles)) throw new Error(`publication batch is invalid: ${dateValue}`);
    return {
      ...(typeof value.recorded_at === "string" ? { recorded_at: value.recorded_at } : {}),
      articles: value.articles.filter((item): item is { article_id: string; first_publication: boolean } =>
        typeof item.article_id === "string" && item.article_id.length > 0 && typeof item.first_publication === "boolean"
      )
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function publicationDateFromTimestamp(value: string | undefined) {
  return /^\d{4}-\d{2}-\d{2}T/u.test(value || "") ? value!.slice(0, 10) : undefined;
}

async function markXPosted(dateValue: string, selected: XArticle[]) {
  const targets = new Set(selected.flatMap((item) => item.articleId ? [item.articleId] : []));
  if (!targets.size) return;
  const directory = path.join(dataDir, dateValue);
  const review = await readPublicationReview(directory);
  if (!review) return;
  let changed = false;
  const postedAt = shanghaiTimestamp();
  for (const article of review.articles) {
    if (!targets.has(articleIdFor(review, article))) continue;
    article.publication = {
      ...article.publication,
      slug: article.publication?.slug || String(article.index),
      x_posted_at: postedAt,
      x_pending_at: undefined,
      x_post_attempt_id: undefined,
      x_post_attempted_at: undefined
    };
    changed = true;
  }
  if (changed) await writeReview(directory, review);
}

function shanghaiTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

async function writeReview(directory: string, review: PublicationReviewState) {
  await fs.writeFile(path.join(directory, "review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

function normalizeArticle(value: unknown): ProcessedArticle {
  const record = value as Record<string, unknown>;
  if (record?.raw && record.summary) return value as ProcessedArticle;
  const summary = value as SummarizedArticle;
  if (typeof summary?.title_ja !== "string") throw new Error("X投稿用記事データの形式が不正です");
  const firstSource = summary.source_list?.[0];
  return {
    raw: {
      title: summary.title_ja,
      url: firstSource?.url || "",
      sourceName: firstSource?.name || "",
      sourceUrl: firstSource?.url || "",
      category: summary.category,
      reliability: summary.confidence
    },
    summary
  };
}

async function writePostTexts(dateValue: string, digest: string, articles: ProcessedArticle[]) {
  const posts = buildIndividualPosts(articles);
  const markdown = buildPostsMarkdown(dateValue, digest, posts);
  const outputDir = path.resolve(process.env.SITE_OUTPUT_DIR || "output");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `x_posts_${dateValue}.md`);
  await fs.writeFile(outputPath, markdown, "utf8");
  console.log(`X post texts: ${outputPath}（個別投稿候補 ${posts.length}件）`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
}

async function writeNoPostTexts(dateValue: string) {
  const outputDir = path.resolve(process.env.SITE_OUTPUT_DIR || "output");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `x_posts_${dateValue}.md`);
  const markdown = `# X投稿文面 ${dateValue}\n\n今回の公開分には、未投稿の自動X投稿対象がありません。\n`;
  await fs.writeFile(outputPath, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
}

async function postTweet(text: string) {
  const credentials = {
    consumerKey: requireEnv("X_API_KEY"),
    consumerSecret: requireEnv("X_API_SECRET"),
    accessToken: requireEnv("X_ACCESS_TOKEN"),
    accessSecret: requireEnv("X_ACCESS_SECRET")
  };
  const endpoint = "https://api.x.com/2/tweets";
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(18).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  };
  const parameterString = Object.entries(oauth).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const baseString = `POST&${encode(endpoint)}&${encode(parameterString)}`;
  const signingKey = `${encode(credentials.consumerSecret)}&${encode(credentials.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const authorization = `OAuth ${Object.entries(oauth).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${encode(key)}=\"${encode(value)}\"`).join(", ")}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) throw new Error(`X API ${response.status}: ${await response.text()}`);
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

function normalizeBasePath(value: string) {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
