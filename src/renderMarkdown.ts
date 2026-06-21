import fs from "node:fs/promises";
import path from "node:path";
import type { AiProvider, ProcessedArticle } from "./types.js";

export async function renderMarkdownFile(articles: ProcessedArticle[], provider: AiProvider, date = today()) {
  const outputPath = path.resolve("output", `${date}-${provider}.md`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderMarkdown(articles, date, provider), "utf8");
  return outputPath;
}

function renderMarkdown(articles: ProcessedArticle[], date: string, provider: AiProvider) {
  const publishableArticles = articles.filter((article) => article.summary);
  const body = publishableArticles.length
    ? publishableArticles.map((article, index) => renderArticle(article, index + 1)).join("\n\n")
    : "今日は出力できる記事がありませんでした。\n";

  return `# 中国エンタメニュース ${date}

AI provider: ${provider}

${body}
`;
}

function renderArticle(article: ProcessedArticle, index: number) {
  const { raw, summary } = article;
  if (!summary) {
    return "";
  }

  const title = summary.title_ja || raw.title;
  const sources = summary.source_list.length ? summary.source_list : [raw.sourceName];
  const sections = [
    summary.lead,
    summary.what_happened ? `### 何が起きた？\n${summary.what_happened}` : "",
    summary.reaction_view ? `### 反応・見られ方\n${summary.reaction_view}` : "",
    summary.editor_note ? `### 編集メモ\n${summary.editor_note}` : "",
    `ソース：${sources.join("、")}`
  ].filter(Boolean);

  return `## 【${summary.category || raw.category}｜確度${summary.confidence || raw.reliability}】${title}

${sections.join("\n\n")}`;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
