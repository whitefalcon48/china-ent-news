import fs from "node:fs/promises";
import path from "node:path";
import { resolveSummaryTitle } from "./summaryTitle.js";
import type { AiProvider, ProcessedArticle } from "./types.js";

export async function renderMarkdownFile(articles: ProcessedArticle[], provider: AiProvider, date = today()) {
  const outputPath = path.resolve("output", `${date}-${provider}.md`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderMarkdown(articles, date, provider), "utf8");
  return outputPath;
}

function renderMarkdown(articles: ProcessedArticle[], date: string, provider: AiProvider) {
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  const publishableArticles = articles
    .filter((article) => article.summary)
    .sort((left, right) => {
      const priorityDifference = priorityRank[left.summary?.publish_priority ?? "medium"] - priorityRank[right.summary?.publish_priority ?? "medium"];
      return priorityDifference || (right.summary?.newsworthiness_score ?? 0) - (left.summary?.newsworthiness_score ?? 0);
    });
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

  const title = resolveSummaryTitle(summary.title_ja, raw.title);
  const sources = summary.source_list.length ? summary.source_list : [{ name: raw.sourceName, url: raw.url }];
  const freshness = formatFreshness(summary.event_date || summary.published_date, summary.freshness_label);
  const sections = [
    summary.lead,
    `source_type: ${summary.source_type} / freshness_label: ${summary.freshness_label}`,
    formatSourceMix(article),
    summary.what_happened ? `### 何が起きた？\n${summary.what_happened}` : "",
    summary.why_it_matters ? `### ビンタンの注目ポイント\n${summary.why_it_matters}` : "",
    summary.reaction_view ? `### 反応・見られ方\n${summary.reaction_view}` : "",
    summary.japan_context_note ? `### 日本語圏では見えにくいポイント\n${summary.japan_context_note}` : "",
    summary.editor_comment ? `### ビンタンからのひとこと\n${summary.editor_comment}` : "",
    `ソース：${sources.map(formatSourceLink).join("、")}`
  ].filter(Boolean);

  return `## 【${summary.badge}｜${summary.category || raw.category}｜確度${summary.confidence || raw.reliability}｜${freshness}】${title}

${sections.join("\n\n")}`;
}

function formatSourceMix(article: ProcessedArticle) {
  const summary = article.summary;
  if (!summary) return "";

  const mix = article.topic?.source_mix;
  const official = mix ? mix.official + mix.pr_like : summary.source_type === "official" || summary.source_type === "pr_like" ? 1 : 0;
  const media = mix ? mix.media_report + mix.mixed : summary.source_type === "media_report" || summary.source_type === "mixed" ? 1 : 0;
  const sns = mix ? mix.sns + mix.rumor : summary.source_type === "sns" || summary.source_type === "rumor" ? 1 : 0;
  const data = mix ? mix.data : summary.source_type === "data" ? 1 : 0;
  const officialOnly = official > 0 && media + sns + data === 0 ? "（公式発表のみ・裏付けなし）" : "";
  return `ソース構成: 公式${official}・媒体${media}・SNS ${sns}・データ${data}${officialOnly}`;
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
