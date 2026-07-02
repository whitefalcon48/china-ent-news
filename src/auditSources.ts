import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { classifyArticle, getArticleDateInfo, isPublishableType, loadFilterConfig } from "./classifyArticle.js";
import { dedupeArticles } from "./dedupe.js";
import { enrichArticleMetadata, fetchAllSources, loadSources } from "./fetchSources.js";
import type { AuditExcludeStage, FreshnessLabel, NewsSource, RawArticle, SourceAuditSample, SourceDiagnostic } from "./types.js";

type AuditSampleItem = {
  title: string;
  url: string;
  published_date: string;
  date_source: string;
  date_extraction_note: string;
  age_days: number | null;
  freshness: string;
  category: string;
  article_type: string;
  exclude_stage: AuditExcludeStage;
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
  low_priority_candidate_count: number;
  sample_items: AuditSampleItem[];
};

type ExternalSourceStatus = {
  name: string;
  status: "not_configured" | "failed" | "empty" | "success";
  note: string;
};

const FRESH_LABELS: FreshnessLabel[] = ["today", "yesterday", "recent"];
const MAX_SAMPLE_ITEMS = 10;

async function main() {
  const date = today();
  const sources = await loadSources();
  const filterConfig = await loadFilterConfig();
  const { articles, diagnostics } = await fetchAllSources(sources);
  const enrichedArticles = await enrichMissingDateMetadata(articles);
  const dedupedArticles = dedupeArticles(enrichedArticles);
  const classifiedArticles = dedupedArticles.map((article) => classifyArticle(article, filterConfig));
  const dedupeSamples = buildDedupeSamples(enrichedArticles, dedupedArticles);
  const externalSources = buildExternalSourceStatuses(sources);
  const auditResults = diagnostics
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName, "ja"))
    .map((diagnostic) => buildSourceAudit(diagnostic, classifiedArticles, dedupeSamples));

  await fs.mkdir(path.resolve("output"), { recursive: true });
  const jsonPath = path.resolve("output", `source-audit-${date}.json`);
  const mdPath = path.resolve("output", `source-audit-${date}.md`);
  await fs.writeFile(jsonPath, JSON.stringify({ date, generated_at: new Date().toISOString(), external_sources: externalSources, sources: auditResults }, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdown(date, auditResults, externalSources), "utf8");

  logSummary(auditResults, externalSources);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

async function enrichMissingDateMetadata(articles: RawArticle[]) {
  const results: RawArticle[] = [];
  const queue = [...articles];
  const workerCount = Math.min(5, queue.length || 1);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const article = queue.shift();
        if (!article) {
          continue;
        }
        const dateInfo = getArticleDateInfo(article);
        if (dateInfo.dateSource !== "unknown") {
          results.push(article);
          continue;
        }
        results.push(await enrichArticleMetadata(article));
      }
    })
  );

  return results;
}

function buildSourceAudit(diagnostic: SourceDiagnostic, articles: RawArticle[], dedupeSamples: Map<string, SourceAuditSample[]>): SourceAuditResult {
  const sourceArticles = articles.filter((article) => article.sourceName === diagnostic.sourceName);
  const fetchStatus = diagnostic.error ? "failed" : sourceArticles.length ? "success" : "empty";
  const validDateCount = sourceArticles.filter((article) => Boolean(article.publishedDate)).length;
  const freshCount = sourceArticles.filter((article) => FRESH_LABELS.includes(article.freshnessLabel ?? "unknown")).length;
  const staleCount = sourceArticles.filter((article) => article.freshnessLabel === "stale").length;
  const oldCount = sourceArticles.filter((article) => article.freshnessLabel === "old").length;
  const unknownDateCount = sourceArticles.filter((article) => !article.publishedDate || article.freshnessLabel === "unknown").length;
  const aiCandidateCount = sourceArticles.filter(isAiCandidate).length;
  const lowPriorityCandidateCount = sourceArticles.filter(isLowPriorityUnknownCandidate).length;
  const sourceDedupeSamples = dedupeSamples.get(diagnostic.sourceName) ?? [];

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
    low_priority_candidate_count: lowPriorityCandidateCount,
    sample_items: buildSampleItems(diagnostic.auditSamples ?? [], sourceDedupeSamples, sourceArticles)
  };
}

function buildSampleItems(fetchSamples: SourceAuditSample[], dedupeSamples: SourceAuditSample[], articles: RawArticle[]) {
  const articleSamples = articles.map(toSampleItem);
  const freshArticleSamples = articleSamples.filter((item) => FRESH_LABELS.includes(item.freshness as FreshnessLabel));
  const droppedSamples = [...fetchSamples, ...dedupeSamples].map(toDroppedSampleItem);
  return pickDiverseSamples(freshArticleSamples, [...droppedSamples, ...articleSamples], MAX_SAMPLE_ITEMS);
}

function pickDiverseSamples(prioritySamples: AuditSampleItem[], samples: AuditSampleItem[], maxItems: number) {
  const selected: AuditSampleItem[] = [];
  const seenKeys = new Set<string>();
  const add = (sample: AuditSampleItem | undefined) => {
    if (!sample || selected.length >= maxItems) {
      return;
    }
    const key = sampleKey(sample);
    if (seenKeys.has(key)) {
      return;
    }
    selected.push(sample);
    seenKeys.add(key);
  };

  for (const sample of prioritySamples) {
    add(sample);
  }

  const stages: AuditExcludeStage[] = ["url_exclude", "article_type_exclude", "dedupe", "date_unknown", "freshness_stale", "freshness_old", "before_2026", ""];
  for (const stage of stages) {
    add(samples.find((item) => item.exclude_stage === stage && !seenKeys.has(sampleKey(item))));
  }

  for (const sample of samples) {
    add(sample);
    if (selected.length >= maxItems) {
      break;
    }
  }

  return selected;
}

function sampleKey(item: AuditSampleItem) {
  return item.url || item.title;
}

function isAiCandidate(article: RawArticle) {
  if (article.skipReason) {
    return false;
  }
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return false;
  }
  if (!FRESH_LABELS.includes(article.freshnessLabel ?? "unknown")) {
    return false;
  }
  return isPublishableType(article.articleType ?? "unknown") || isLowPriorityUnknownCandidate(article);
}

function isLowPriorityUnknownCandidate(article: RawArticle) {
  if ((article.articleType ?? "unknown") !== "unknown") {
    return false;
  }
  if (article.skipReason) {
    return false;
  }
  if (!FRESH_LABELS.includes(article.freshnessLabel ?? "unknown")) {
    return false;
  }
  return ["\u6620\u753b", "\u82b8\u80fd\u30fb\u4ff3\u512a", "\u30c9\u30e9\u30de\u30fb\u914d\u4fe1", "\u696d\u754c\u52d5\u5411"].includes(article.feedCategory ?? article.category);
}

function toSampleItem(article: RawArticle): AuditSampleItem {
  const exclude = getExclude(article);
  return {
    title: article.title,
    url: article.url,
    published_date: article.publishedDate ?? "",
    date_source: article.dateSource ?? "unknown",
    date_extraction_note: article.dateExtractionNote ?? "",
    age_days: article.ageDays ?? null,
    freshness: article.freshnessLabel ?? "unknown",
    category: article.feedCategory ?? article.category,
    article_type: article.articleType ?? "unknown",
    exclude_stage: exclude.stage,
    exclude_reason: exclude.reason
  };
}

function toDroppedSampleItem(sample: SourceAuditSample): AuditSampleItem {
  return {
    title: sample.title,
    url: sample.url,
    published_date: "",
    date_source: "unknown",
    date_extraction_note: "not_checked_after_early_exclude",
    age_days: null,
    freshness: "",
    category: "",
    article_type: "",
    exclude_stage: sample.excludeStage,
    exclude_reason: sample.excludeReason
  };
}

function getExclude(article: RawArticle): { stage: AuditExcludeStage; reason: string } {
  if (article.skipReason) {
    return { stage: "article_type_exclude", reason: article.skipReason };
  }
  if (!isPublishableType(article.articleType ?? "unknown") && !isLowPriorityUnknownCandidate(article)) {
    return { stage: article.freshnessLabel === "unknown" ? "date_unknown" : "article_type_exclude", reason: article.articleType ?? "not_publishable" };
  }
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return { stage: "before_2026", reason: "before_2026" };
  }
  if (article.freshnessLabel === "unknown") {
    return { stage: "date_unknown", reason: article.dateExtractionNote || "date_unknown" };
  }
  if (article.freshnessLabel === "stale") {
    return { stage: "freshness_stale", reason: "freshness_stale" };
  }
  if (article.freshnessLabel === "old") {
    return { stage: "freshness_old", reason: "freshness_old" };
  }
  return { stage: "", reason: "" };
}

function buildDedupeSamples(articles: RawArticle[], dedupedArticles: RawArticle[]) {
  const dedupedUrls = new Set(dedupedArticles.map((article) => article.url));
  const bySource = new Map<string, SourceAuditSample[]>();
  for (const article of articles) {
    if (dedupedUrls.has(article.url)) {
      continue;
    }
    const samples = bySource.get(article.sourceName) ?? [];
    if (samples.length < 10) {
      samples.push({
        title: article.title,
        url: article.url,
        excludeStage: "dedupe",
        excludeReason: "dedupe_url_or_similar_title"
      });
    }
    bySource.set(article.sourceName, samples);
  }
  return bySource;
}

function buildExternalSourceStatuses(sources: NewsSource[]): ExternalSourceStatus[] {
  const configuredNames = sources.map((source) => `${source.name} ${source.url}`.toLowerCase());
  return [
    { name: "Weibo HOT SEARCH", tokens: ["weibo", "\u5fae\u535a", "hot search", "\u70ed\u641c"] },
    { name: "Douban", tokens: ["douban", "\u8c46\u74e3"] },
    { name: "Maoyan", tokens: ["maoyan", "\u732b\u773c"] },
    { name: "HOT SEARCH", tokens: ["hot search", "\u70ed\u641c"] }
  ].map((target) => {
    const configured = configuredNames.some((name) => target.tokens.some((token) => name.includes(token.toLowerCase())));
    return {
      name: target.name,
      status: configured ? "empty" : "not_configured",
      note: configured ? "configured in sources.json but no dedicated audit fetcher is implemented" : "not present in config/sources.json"
    };
  });
}

function renderMarkdown(date: string, results: SourceAuditResult[], externalSources: ExternalSourceStatus[]) {
  const usable = results.filter((result) => result.ai_candidate_count > 0).map((result) => result.source_name);
  const empty = results.filter((result) => result.fetch_status === "empty").map((result) => result.source_name);
  const failed = results.filter((result) => result.fetch_status === "failed").map((result) => result.source_name);
  const oldHeavy = results
    .filter((result) => result.after_dedupe_count > 0 && result.fresh_count === 0 && result.old_count + result.stale_count + result.unknown_date_count > 0)
    .map((result) => result.source_name);
  const movieHeavy = results
    .filter((result) => (result.category_counts["\u6620\u753b"] ?? 0) + (result.category_counts["\u6d77\u5916\u4e2d\u56fd\u6620\u753b\u796d\u30fb\u6587\u5316\u4ea4\u6d41"] ?? 0) >= Math.max(3, result.after_dedupe_count * 0.7))
    .map((result) => result.source_name);

  const externalSection = externalSources.map((source) => `- ${source.name}: ${source.status} (${source.note})`).join("\n");
  const sections = results.map((result) => renderSourceSection(result)).join("\n\n");
  return `# Source Audit ${date}

## Summary
- Usable today: ${usable.length ? usable.join(" / ") : "none"}
- Empty sources: ${empty.length ? empty.join(" / ") : "none"}
- Failed sources: ${failed.length ? failed.join(" / ") : "none"}
- Old or unknown-date heavy: ${oldHeavy.length ? oldHeavy.join(" / ") : "none"}
- Movie-heavy sources: ${movieHeavy.length ? movieHeavy.join(" / ") : "none"}

## Weibo / Douban / Maoyan / HOT SEARCH
${externalSection}

${sections}
`;
}

function renderSourceSection(result: SourceAuditResult) {
  const sampleRows = result.sample_items.length
    ? result.sample_items
        .map(
          (item) =>
            `| ${escapeCell(item.title)} | ${item.published_date || ""} | ${item.date_source} | ${escapeCell(item.date_extraction_note)} | ${item.age_days ?? ""} | ${item.freshness} | ${item.category} | ${item.article_type} | ${item.exclude_stage} | ${escapeCell(item.exclude_reason)} |`
        )
        .join("\n")
    : "| none |  |  |  |  |  |  |  |  |  |";

  return `## ${result.source_name}
- fetch: ${result.fetch_status}${result.fetch_error ? ` (${result.fetch_error})` : ""}
- raw: ${result.raw_count}
- after URL exclude: ${result.after_url_exclude_count}
- after dedupe: ${result.after_dedupe_count}
- valid date: ${result.valid_date_count}
- fresh: ${result.fresh_count}
- stale: ${result.stale_count}
- old: ${result.old_count}
- unknown: ${result.unknown_date_count}
- AI candidates: ${result.ai_candidate_count}
- low priority unknown candidates: ${result.low_priority_candidate_count}
- category: ${formatCounts(result.category_counts)}
- article_type: ${formatCounts(result.article_type_counts)}

### sample
| title | published_date | date_source | date_note | age | freshness | category | article_type | exclude_stage | exclude_reason |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
${sampleRows}`;
}

function logSummary(results: SourceAuditResult[], externalSources: ExternalSourceStatus[]) {
  console.log("source audit summary");
  for (const result of results) {
    console.log(`${result.source_name}: fetch=${result.fetch_status}, raw=${result.raw_count}, dedupe=${result.after_dedupe_count}, valid_date=${result.valid_date_count}, fresh=${result.fresh_count}, stale=${result.stale_count}, old=${result.old_count}, unknown=${result.unknown_date_count}, ai_candidates=${result.ai_candidate_count}, low_priority_unknown=${result.low_priority_candidate_count}`);
  }
  console.log("external source status");
  for (const source of externalSources) {
    console.log(`${source.name}: ${source.status}`);
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
  return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(" / ") : "none";
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
