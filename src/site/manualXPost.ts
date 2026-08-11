import fs from "node:fs/promises";
import path from "node:path";
import { truncateToWeight, xWeightedLength, MAX_WEIGHTED_LENGTH } from "./xPostTexts.js";
import { resolveSummaryTitle } from "../summaryTitle.js";
import type { ProcessedArticle } from "../types.js";

const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
const outputDir = path.resolve(process.env.SITE_OUTPUT_DIR || "output");
const commentId = process.env.MANUAL_COMMENT_ID || "";
const publishedDate = process.env.MANUAL_PUBLISHED_DATE || "";
const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");

if (!/^\d+$/.test(commentId)) throw new Error("MANUAL_COMMENT_ID is required");
if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) throw new Error("MANUAL_PUBLISHED_DATE is required (YYYY-MM-DD)");
if (!siteUrl) throw new Error("SITE_URL is required");

const directory = path.join(dataDir, "manual-intake", commentId);
const articleFile = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
if (!articleFile) throw new Error(`manual articles JSON not found: ${directory}`);
const articles = JSON.parse(await fs.readFile(path.join(directory, articleFile), "utf8")) as ProcessedArticle[];
const review = JSON.parse(await fs.readFile(path.join(directory, "review.json"), "utf8")) as { articles?: Array<{ index: number; status: string }> };
const article = review.articles?.find((item) => item.status === "approved")
  ? articles[review.articles.find((item) => item.status === "approved")!.index - 1]
  : undefined;
if (!article?.summary) throw new Error("manual approved article not found");

const title = resolveSummaryTitle(article.summary.title_ja, article.raw.title);
const url = `${siteUrl}/t/${publishedDate}/m-${commentId}/`;
const prefix = `🧊 ${title}${/[。！？!?]$/.test(title) ? "" : "。"}`;
const suffix = `\n${url}`;
const text = `${truncateToWeight(`${prefix}${article.summary.lead ? ` ${article.summary.lead}` : ""}`, MAX_WEIGHTED_LENGTH - xWeightedLength(suffix))}${suffix}`;
if (xWeightedLength(text) > MAX_WEIGHTED_LENGTH) throw new Error("manual X post exceeds 280 characters");
const body = `✅ 公開しました\n\n${url}\n\nX投稿文面（${xWeightedLength(text)}/${MAX_WEIGHTED_LENGTH}）\n\n\`\`\`\n${text}\n\`\`\`\n`;
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `manual_x_post_${commentId}.md`);
await fs.writeFile(outputPath, body, "utf8");
console.log(`manual X post text: ${outputPath}`);
