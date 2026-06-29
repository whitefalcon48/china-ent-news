import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { classifyArticle, isPublishableType, loadFilterConfig } from "./classifyArticle.js";
import { dedupeArticles } from "./dedupe.js";
import { fetchAllSources, loadSources } from "./fetchSources.js";
import type { ArticleType, FeedCategory, FreshnessLabel, RawArticle, SourceDiagnostic } from "./types.js";

type AuditSampleItem = {
  title: string;
  url: string;
  published_date: string;
  date_source: string;
  age_days: number | null;
  freshness: string;
  category: string;
  article_type: string;
  exclude_reason: string;
};

type SourceAuditResult = {
  source_name: string;
  fetch_status: "success" | "failed" | "empty";
  fetch_error: string;
  raw_count: number;
  after_url_exclude_count: number;
  after_dedupe_count: number;
  valid_date_count: number;
  fresh_count: number;
  stale_count: number;
  old_count: number;
  unknown_date_count: number;
  category_counts: Record<string, number>;
  article_type_counts: Record<string, number>;
  ai_candidate_count: number;
  sample_items: AuditSampleItem[];
};

const FRESH_LABELS: FreshnessLabel[] = ["today", "yesterday", "recent"];

async function main() {
  const date = today();
  const sources = await loadSources();
  const filterConfig = await loadFilterConfig();
  const { articles, diagnostics } = await fetchAllSources(sources);
  const dedupedArticles = dedupeArticles(articles);
  const classifiedArticles = dedupedArticles.map((article) => classifyArticle(article, filterConfig));
  const auditResults = diagnostics
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName, "ja"))
    .map((diagnostic) => buildSourceAudit(diagnostic, classifiedArticles));

  await fs.mkdir(path.resolve("output"), { recursive: true });
  const jsonPath = path.resolve("output", `source-audit-${date}.json`);
  const mdPath = path.resolve("output", `source-audit-${date}.md`);
  await fs.writeFile(jsonPath, JSON.stringify({ date, generated_at: new Date().toISOString(), sources: auditResults }, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdown(date, auditResults), "utf8");

  logSummary(auditResults);
  console.log(`JSON出力: ${jsonPath}`);
  console.log(`Markdown出力: ${mdPath}`);
}

function buildSourceAudit(diagnostic: SourceDiagnostic, articles: RawArticle[]): SourceAuditResult {
  const sourceArticles = articles.filter((article) => article.sourceName === diagnostic.sourceName);
  const fetchStatus = diagnostic.error ? "failed" : sourceArticles.length ? "success" : "empty";
  const validDateCount = sourceArticles.filter((article) => Boolean(article.publishedDate)).length;
  const freshCount = sourceArticles.filter((article) => FRESH_LABELS.includes(article.freshnessLabel ?? "unknown")).length;
  const staleCount = sourceArticles.filter((article) => article.freshnessLabel === "stale").length;
  const oldCount = sourceArticles.filter((article) => article.freshnessLabel === "old").length;
  const unknownDateCount = sourceArticles.filter((article) => !article.publishedDate || article.freshnessLabel === "unknown").length;
  const aiCandidateCount = sourceArticles.filter(isAiCandidate).length;

  return {
    source_name: diagnostic.sourceName,
    fetch_status: fetchStatus,
    fetch_error: diagnostic.error ?? "",
    raw_count: diagnostic.rawCount ?? diagnostic.fetchedCount,
    after_url_exclude_count: diagnostic.afterUrlExcludeCount ?? diagnostic.fetchedCount,
    after_dedupe_count: sourceArticles.length,
    valid_date_count: validDateCount,
    fresh_count: freshCount,
    stale_count: staleCount,
    old_count: oldCount,
    unknown_date_count: unknownDateCount,
    category_counts: countValues(sourceArticles.map((article) => article.feedCategory ?? article.category)),
    article_type_counts: countValues(sourceArticles.map((article) => article.articleType ?? "unknown")),
    ai_candidate_count: aiCandidateCount,
    sample_items: sourceArticles.slice(0, 10).map(toSampleItem)
  };
}

function isAiCandidate(article: RawArticle) {
  if (!isPublishableType(article.articleType ?? "unknown")) {
    return false;
  }
  if (article.skipReason) {
    return false;
  }
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return false;
  }
  return FRESH_LABELS.includes(article.freshnessLabel ?? "unknown");
}

function toSampleItem(article: RawArticle): AuditSampleItem {
  return {
    title: article.title,
    url: article.url,
    published_date: article.publishedDate ?? "",
    date_source: article.dateSource ?? "unknown",
    age_days: article.ageDays ?? null,
    freshness: article.freshnessLabel ?? "unknown",
    category: article.feedCategory ?? article.category,
    article_type: article.articleType ?? "unknown",
    exclude_reason: getExcludeReason(article)
  };
}

function getExcludeReason(article: RawArticle) {
  if (article.skipReason) {
    return article.skipReason;
  }
  if (!isPublishableType(article.articleType ?? "unknown")) {
    return article.articleType ?? "not_publishable";
  }
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return "before_2026";
  }
  if (!FRESH_LABELS.includes(article.freshnessLabel ?? "unknown")) {
    return `freshness_${article.freshnessLabel ?? "unknown"}`;
  }
  return "";
}

function renderMarkdown(date: string, results: SourceAuditResult[]) {
  const usable = results.filter((result) => result.ai_candidate_count > 0).map((result) => result.source_name);
  const empty = results.filter((result) => result.fetch_status === "empty").map((result) => result.source_name);
  const failed = results.filter((result) => result.fetch_status === "failed").map((result) => result.source_name);
  const oldHeavy = results
    .filter((result) => result.after_dedupe_count > 0 && result.fresh_count === 0 && result.old_count + result.stale_count + result.unknown_date_count > 0)
    .map((result) => result.source_name);
  const movieHeavy = results
    .filter((result) => (result.category_counts["映画"] ?? 0) + (result.category_counts["海外中国映画祭・文化交流"] ?? 0) >= Math.max(3, result.after_dedupe_count * 0.7))
    .map((result) => result.source_name);

  const sections = results.map((result) => renderSourceSection(result)).join("\n\n");
  return `# Source Audit ${date}

## 全体診断
- 今日使えるソース: ${usable.length ? usable.join("、") : "なし"}
- 空振りソース: ${empty.length ? empty.join("、") : "なし"}
- 取得失敗ソース: ${failed.length ? failed.join("、") : "なし"}
- 古い/日付不明が中心のソース: ${oldHeavy.length ? oldHeavy.join("、") : "なし"}
- 映画・映画祭寄りのソース: ${movieHeavy.length ? movieHeavy.join("、") : "なし"}

${sections}
`;
}

function renderSourceSection(result: SourceAuditResult) {
  const sampleRows = result.sample_items.length
    ? result.sample_items
        .map(
          (item) =>
            `| ${escapeCell(item.title)} | ${item.published_date || "不明"} | ${item.date_source} | ${item.age_days ?? ""} | ${item.freshness} | ${item.category} | ${item.article_type} | ${escapeCell(item.exclude_reason)} |`
        )
        .join("\n")
    : "| なし |  |  |  |  |  |  |  |";

  return `## ${result.source_name}
- fetch: ${result.fetch_status}${result.fetch_error ? ` (${result.fetch_error})` : ""}
- raw: ${result.raw_count}
- URL除外後: ${result.after_url_exclude_count}
- dedupe後: ${result.after_dedupe_count}
- valid date: ${result.valid_date_count}
- fresh: ${result.fresh_count}
- stale: ${result.stale_count}
- old: ${result.old_count}
- unknown: ${result.unknown_date_count}
- AI候補にできる記事: ${result.ai_candidate_count}
- category: ${formatCounts(result.category_counts)}
- article_type: ${formatCounts(result.article_type_counts)}

### sample
| title | published_date | date_source | age | freshness | category | article_type | exclude_reason |
| --- | --- | --- | ---: | --- | --- | --- | --- |
${sampleRows}`;
}

function logSummary(results: SourceAuditResult[]) {
  console.log("source audit summary");
  for (const result of results) {
    console.log(`${result.source_name}: fetch=${result.fetch_status}, raw=${result.raw_count}, dedupe=${result.after_dedupe_count}, fresh=${result.fresh_count}, stale=${result.stale_count}, old=${result.old_count}, unknown=${result.unknown_date_count}, ai_candidates=${result.ai_candidate_count}`);
  }
}

function countValues(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0], "ja"));
  return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(" / ") : "なし";
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`source audit failed: ${message}`);
  process.exitCode = 1;
});
