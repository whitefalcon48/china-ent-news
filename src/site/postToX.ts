import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getPublishableArticles } from "../renderMarkdown.js";
import { resolveSummaryTitle } from "../summaryTitle.js";
import type { ProcessedArticle, ReviewState, SummarizedArticle } from "../types.js";
import { MAX_WEIGHTED_LENGTH, buildIndividualPosts, buildPostsMarkdown, truncateToWeight, xWeightedLength } from "./xPostTexts.js";

const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
const requestedDate = process.env.POST_DATE;
const siteUrl = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.SITE_BASE_PATH || "");
const live = process.env.X_POST_LIVE === "true";

const date = requestedDate || await findLatestDate();
const articles = await loadArticles(date);
const text = buildDigest(date, articles);
if (xWeightedLength(text) > MAX_WEIGHTED_LENGTH) throw new Error(`X文面が上限280（X換算）を超えています: ${xWeightedLength(text)}`);

console.log(`X digest (${xWeightedLength(text)}/${MAX_WEIGHTED_LENGTH} X換算):\n${text}`);
if (!live) {
  console.log("X dry-run: X_POST_LIVE=true ではないため投稿しません");
  await writePostTexts(date, text, articles);
} else {
  await postTweet(text);
  console.log("X post: success");
}

async function findLatestDate() {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const dates = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map((entry) => entry.name).sort();
  const latest = dates.at(-1);
  if (!latest) throw new Error("X投稿用の日次データがありません");
  return latest;
}

async function loadArticles(dateValue: string) {
  const filename = path.join(dataDir, dateValue, `articles_${dateValue}.json`);
  const raw = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${filename}: JSONルートは配列である必要があります`);
  const articles = raw.map((value) => normalizeArticle(value));
  if (process.env.REVIEW_GATE === "false") return getPublishableArticles(articles);
  try {
    const review = JSON.parse(await fs.readFile(path.join(dataDir, dateValue, "review.json"), "utf8")) as ReviewState;
    if (review.status !== "completed") throw new Error(`${dateValue} のレビューが完了していません`);
    return getPublishableArticles(review.articles.filter((item) => item.status === "approved").map((item) => articles[item.index - 1]).filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return getPublishableArticles(articles);
    throw error;
  }
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

export function buildDigest(dateValue: string, articles: ProcessedArticle[]) {
  const [, month, day] = dateValue.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) throw new Error(`X投稿日が不正です: ${dateValue}`);
  const header = `🧊 今日の中国エンタメ｜${Number(month)}/${Number(day)}`;
  const url = `${siteUrl}${basePath}/archive/${dateValue}/`;
  const footer = `ほか全${articles.length}本👇\n${url}`;
  const fixedLength = xWeightedLength(`${header}\n\n${footer}`);
  if (fixedLength >= MAX_WEIGHTED_LENGTH) throw new Error("SITE_URLが長すぎてXダイジェストを組み立てられません");
  const candidates = articles.slice(0, 3).map((article) => {
    if (!article.summary) return "";
    return resolveSummaryTitle(article.summary.title_ja, article.raw.title);
  }).filter(Boolean);
  const lines: string[] = [];
  let remaining = MAX_WEIGHTED_LENGTH - fixedLength;
  for (let index = 0; index < candidates.length; index++) {
    const remainingItems = candidates.length - index;
    const allowance = Math.max(20, Math.floor((remaining - remainingItems * 3) / remainingItems));
    const line = `・${truncateToWeight(candidates[index], allowance - 2)}`;
    const cost = xWeightedLength(line) + 1;
    if (cost > remaining) break;
    lines.push(line);
    remaining -= cost;
  }
  for (let index = 0; index < lines.length && remaining > 0; index++) {
    const full = `・${candidates[index]}`;
    if (lines[index] === full) continue;
    const currentCost = xWeightedLength(lines[index]);
    const expanded = xWeightedLength(full) - currentCost <= remaining ? full : `・${truncateToWeight(candidates[index], currentCost - 2 + remaining)}`;
    remaining -= xWeightedLength(expanded) - currentCost;
    lines[index] = expanded;
  }
  return `${header}\n${lines.join("\n")}\n${footer}`;
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
