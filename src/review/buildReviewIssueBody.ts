import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readReviewState, writeReviewState } from "./reviewState.js";
import type { ProcessedArticle, ReviewState, SourceRef } from "../types.js";

export function buildReviewIssueBody(state: ReviewState, articles: ProcessedArticle[]) {
  const header = `# 📋 ニュースレビュー ${state.date}（${state.articles.length}本）

判定はこのIssueへの返信コメントで。1コメントにまとめて書けます。

- \`<番号> 採用\`
- \`<番号> 却下 <理由タグ> <コメント>\`
- \`<番号> 修正 <理由タグ> <修正指示>\`
- \`残り採用\`（未判定をすべて採用）
- 理由タグ: 選定 / 口調 / 用語 / 事実 / 構成 / その他

---`;
  const entries = state.articles.map((reviewArticle) => {
    const article = articles[reviewArticle.index - 1];
    return article ? formatReviewArticle(reviewArticle.index, article) : `## ${reviewArticle.index}. ${reviewArticle.title}\n\n⚠️ 記事データを読み込めませんでした。`;
  });
  return `${header}\n\n${entries.join("\n\n---\n\n")}\n`;
}

export function formatReviewArticle(index: number, article: ProcessedArticle, revised = false) {
  const summary = article.summary;
  if (!summary) return `## ${index}. ⚠️ 要約なし`;
  const sources = summary.source_list.length ? summary.source_list : [{ name: article.raw.sourceName, url: article.raw.url }];
  const prefix = revised ? `🔄 修正版 ${index}` : `${index}. 【${summary.badge}｜${summary.category || article.raw.category}｜確度${summary.confidence || article.raw.reliability}】${summary.title_ja || article.raw.title}`;
  return `## ${prefix}

${summary.lead}

${summary.what_happened}

**ビンタンの注目ポイント**: ${summary.why_it_matters}

**ひとこと**: ${summary.editor_comment}

ソース: ${sources.map(formatSource).join(" / ")}`;
}

async function main() {
  if (process.env.REVIEW_GATE === "false") return;
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const date = process.env.REVIEW_DATE || await latestDate(dataDir);
  const directory = path.join(dataDir, date);
  const reviewPath = path.join(directory, "review.json");
  const state = await readReviewState(reviewPath);
  if (state.issue_number > 0 && process.env.RECREATE_REVIEW_ISSUE !== "true") {
    console.log(`review issue: #${state.issue_number} already exists`);
    return;
  }
  const articleFile = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!articleFile) throw new Error(`articles JSON not found: ${directory}`);
  const articles = JSON.parse(await fs.readFile(path.join(directory, articleFile), "utf8")) as ProcessedArticle[];
  const body = buildReviewIssueBody(state, articles);
  const scratch = path.join(directory, ".review-issue-body.md");
  await fs.writeFile(scratch, body, "utf8");
  try {
    execFileSync("gh", ["label", "create", "daily-review", "--description", "Daily generated-news review", "--color", "C12B23", "--force"], { stdio: "pipe" });
    const url = execFileSync("gh", ["issue", "create", "--title", `📋 ニュースレビュー ${date}`, "--label", "daily-review", "--body-file", scratch], { encoding: "utf8" }).trim();
    const issueNumber = Number(url.match(/\/(\d+)\/?$/)?.[1]);
    if (!issueNumber) throw new Error(`Issue number not found in gh output: ${url}`);
    state.issue_number = issueNumber;
    await writeReviewState(reviewPath, state);
    console.log(`review issue: ${url}`);
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

async function latestDate(dataDir: string) {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const latest = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map((entry) => entry.name).sort().at(-1);
  if (!latest) throw new Error(`review date not found: ${dataDir}`);
  return latest;
}

function formatSource(source: SourceRef) {
  return source.url ? `[${source.name}](${source.url})` : source.name;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error) => {
    console.warn(`review issue warning: ${error instanceof Error ? error.message : String(error)}`);
  });
}
