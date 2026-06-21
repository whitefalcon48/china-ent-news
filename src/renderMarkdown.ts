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
  const body = articles.length
    ? articles.map((article, index) => renderArticle(article, index + 1)).join("\n\n")
    : "今日は出力できる記事がありませんでした。\n";

  return `# 中国エンタメニュース ${date}

AI provider: ${provider}

${body}
`;
}

function renderArticle(article: ProcessedArticle, index: number) {
  const { raw, summary, aiError } = article;

  if (!summary) {
    return `## ${index}. ${raw.title}

**カテゴリ**：${raw.category}  
**確度**：${raw.reliability}  
**出典**：${raw.sourceName}  
**URL**：${raw.url}

### AI処理失敗
AI APIでこの記事を整理できませんでした。

### 原因メモ
- ${aiError ?? "詳細不明"}`;
  }

  const sections = [
    renderListSection("要点", summary.summary_bullets),
    summary.body_ja ? `### 本文\n${summary.body_ja}` : "",
    renderListSection("確認済みの事実", summary.confirmed_facts),
    renderListSection("報道内容", summary.reported_claims),
    renderListSection("SNS反応", summary.sns_reactions),
    renderListSection("未確認情報・注意点", summary.unverified_points),
    renderListSection("見方が分かれる点", summary.multiple_viewpoints),
    summary.source_notes ? `### 出典メモ\n${summary.source_notes}` : "",
    renderTags(summary.tags)
  ].filter(Boolean);

  return `## ${index}. ${summary.title_ja}

**カテゴリ**：${summary.category || raw.category}  
**確度**：${summary.confidence || raw.reliability}  
**出典**：${raw.sourceName}  
**URL**：${raw.url}

${sections.join("\n\n")}`;
}

function renderListSection(title: string, items: string[]) {
  if (!items.length) {
    return "";
  }

  return `### ${title}
${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderTags(tags: string[]) {
  if (!tags.length) {
    return "";
  }

  return `### タグ
${tags.join(" / ")}`;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
