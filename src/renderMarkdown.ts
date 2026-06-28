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
  const sources = summary.source_list.length ? summary.source_list : [{ name: raw.sourceName, url: raw.url }];
  const freshness = formatFreshness(summary.event_date || summary.published_date, summary.freshness_label);
  const sections = [
    summary.lead,
    `source_type: ${summary.source_type} / freshness_label: ${summary.freshness_label}`,
    summary.what_happened ? `### 何が起きた？\n${summary.what_happened}` : "",
    summary.why_it_matters ? `### なぜ話題？\n${summary.why_it_matters}` : "",
    summary.reaction_view ? `### 反応・見られ方\n${summary.reaction_view}` : "",
    summary.japan_context_note ? `### 日本語圏では見えにくいポイント\n${summary.japan_context_note}` : "",
    summary.editor_comment ? `### ひとこと\n${summary.editor_comment}` : "",
    `ソース：${sources.map(formatSourceLink).join("、")}`
  ].filter(Boolean);

  return `## 【${summary.badge}｜${summary.category || raw.category}｜確度${summary.confidence || raw.reliability}｜${freshness}】${title}

${sections.join("\n\n")}`;
}

function formatSourceLink(source: { name: string; url?: string }) {
  return source.url ? `[${source.name}](${source.url})` : source.name;
}

function formatFreshness(dateValue: string, label: string) {
  if (dateValue) {
    const [, month, day] = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
    if (month && day) {
      return `${Number(month)}/${Number(day)}`;
    }
  }

  const labels: Record<string, string> = {
    today: "今日",
    yesterday: "昨日",
    recent: "近日",
    old: "旧聞",
    background: "背景"
  };
  return labels[label] ?? "時期不明";
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
