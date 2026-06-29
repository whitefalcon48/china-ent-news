import "dotenv/config";
import { classifyArticle, isPublishableType, loadFilterConfig } from "./classifyArticle.js";
import { dedupeArticles } from "./dedupe.js";
import { enrichArticleContent, fetchAllSources, loadSources } from "./fetchSources.js";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { describeError, getAiProvider, getProviderEnvStatus, summarizeArticle } from "./summarizeWithGemini.js";
import type { ArticleType, FeedCategory, ProcessedArticle, RawArticle, SourceDiagnostic } from "./types.js";

const MAX_ARTICLES_PER_SOURCE = 3;
const MAX_LOW_PRIORITY_ARTICLES = 1;
const CATEGORY_LIMITS: Record<FeedCategory, number> = {
  "映画": 3,
  "ドラマ・配信": 2,
  "芸能・俳優": 2,
  "業界動向": 2,
  "公式発表": 2,
  "海外中国映画祭・文化交流": 1,
  "その他": 1
};
const MIN_RAW_CONTENT_LENGTH = 180;
const MIN_OFFICIAL_RAW_CONTENT_LENGTH = 80;

async function main() {
  const maxArticles = Number(process.env.MAX_ARTICLES || 8);
  const sources = await loadSources();
  const filterConfig = await loadFilterConfig();
  const provider = getAiProvider();
  const aiEnv = getProviderEnvStatus(provider);

  console.log(`収集元: ${sources.length}件`);
  console.log(`AI_PROVIDER: ${provider}`);
  console.log(`${provider === "gemini" ? "GEMINI_API_KEY" : "DEEPSEEK_API_KEY"}: ${aiEnv.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`AI_MODEL: ${aiEnv.model}`);

  const { articles, errors, diagnostics } = await fetchAllSources(sources);
  const dedupedArticles = dedupeArticles(articles);
  const classifiedArticles = attachRelatedSources(dedupedArticles.map((article) => classifyArticle(article, filterConfig)));
  const topicMergeResult = mergeTopicDuplicates(classifiedArticles);
  const preAiExclusions = classifiedArticles
    .filter((article) => article.skipReason || !isPublishableType(article.articleType ?? "unknown"))
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: article.skipReason || article.articleType || "not_publishable"
    }));
  const eligibleArticles = topicMergeResult.articles.filter((article) => !article.skipReason && isPublishableType(article.articleType ?? "unknown"));
  const freshnessExclusions = eligibleArticles
    .filter((article) => !isFreshEnoughForNormalFeed(article))
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: `freshness_${article.freshnessLabel ?? "unknown"}${article.publishedDate ? `(${article.publishedDate})` : ""}`
    }));
  const freshEligibleArticles = eligibleArticles.filter(isFreshEnoughForNormalFeed);
  const selectedCandidates = selectArticlesForAi(freshEligibleArticles, maxArticles, MAX_ARTICLES_PER_SOURCE);
  const enrichedSelectedCandidates = await Promise.all(selectedCandidates.map((article) => enrichArticleContent(article)));
  const rawContentExclusions = enrichedSelectedCandidates
    .filter(isTooThinForPublishing)
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: `raw_content_too_short(${article.rawContentLength ?? 0})`
    }));
  const selectedArticles = enrichedSelectedCandidates.filter((article) => !isTooThinForPublishing(article));
  const enrichedDiagnostics = enrichDiagnostics(diagnostics, dedupedArticles, selectedArticles);
  const processed: ProcessedArticle[] = [];
  const aiErrors: string[] = [];
  const postAiExclusions: Array<{ title: string; type: ArticleType; reason: string }> = [];

  logSourceDiagnostics(enrichedDiagnostics);
  logArticleTypeCounts(classifiedArticles);
  logMetadataCounts(classifiedArticles);
  logExclusions("除外記事", preAiExclusions);
  logExclusions("本文量不足の除外記事", rawContentExclusions);
  console.log(`topic_key生成件数: ${new Set(classifiedArticles.map((article) => article.topicKey).filter(Boolean)).size}`);
  console.log(`topic統合件数: ${topicMergeResult.mergedTopicCount}`);
  logDuplicateCandidates(topicMergeResult.duplicateCandidates);
  console.log("HOT SEARCH取得: 未実装のためスキップ（graceful fallback）");
  logFinalSourceDistribution(selectedArticles);
  logFinalCategoryDistribution(selectedArticles, "最終AI処理対象のカテゴリ配分");

  for (const article of selectedArticles) {
    try {
      console.log(`AI処理中: ${article.title}`);
      console.log(`source: ${article.sourceName}`);
      console.log(`rawContentLength: ${article.rawContentLength ?? 0}`);
      console.log(`articleType: ${article.articleType ?? "unknown"}`);
      console.log(`category: ${article.feedCategory ?? article.category}`);
      console.log(`badge: ${article.badge ?? "NEWS"}`);
      console.log(`sourceType: ${article.sourceType ?? "media_report"}`);
      console.log(`freshnessLabel: ${article.freshnessLabel ?? "unknown"}`);
      console.log(`newsworthinessScore: ${article.newsworthinessScore ?? 0}`);
      const summary = await summarizeArticle(article, provider);
      if (!isPublishableType(summary.article_type)) {
        postAiExclusions.push({
          title: article.title,
          type: summary.article_type,
          reason: summary.skip_reason || summary.article_type
        });
        continue;
      }
      processed.push({ raw: article, summary });
    } catch (error) {
      const message = describeError(error);
      aiErrors.push(`${article.title}: ${message}`);
      console.error(`AI処理エラー: ${article.title}: ${message}`);
    }
  }

  const outputPath = await renderMarkdownFile(processed, provider);
  logExclusions("AI処理後の除外記事", postAiExclusions);
  logFinalSourceDistribution(
    processed.map((article) => article.raw),
    "最終出力のsource配分"
  );
  logFinalCategoryDistribution(
    processed.map((article) => article.raw),
    "最終出力のカテゴリ配分"
  );

  console.log("");
  console.log("実行結果");
  console.log(`- 取得した記事数: ${articles.length}`);
  console.log(`- 重複除去後の記事数: ${dedupedArticles.length}`);
  console.log(`- 除外件数: ${preAiExclusions.length + rawContentExclusions.length + postAiExclusions.length}`);
  console.log(`- AI処理対象の記事数: ${selectedArticles.length}`);
  console.log(`- AI処理した記事数: ${processed.filter((article) => article.summary).length}`);
  console.log(`- 最終出力件数: ${processed.filter((article) => article.summary).length}`);
  console.log(`- Markdown出力先: ${outputPath}`);

  if (errors.length) {
    console.log("- エラーがあった収集元:");
    errors.forEach((error) => console.log(`  - ${error}`));
  } else {
    console.log("- エラーがあった収集元: なし");
  }

  if (aiErrors.length) {
    console.log("- AI処理エラー:");
    aiErrors.forEach((error) => console.log(`  - ${error}`));
  }
}

function isFreshEnoughForNormalFeed(article: RawArticle) {
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return false;
  }
  return ["today", "yesterday", "recent"].includes(article.freshnessLabel ?? "unknown");
}

function attachRelatedSources(articles: RawArticle[]) {
  const topicSources = new Map<string, Map<string, string>>();
  for (const article of articles) {
    if (!article.topicKey) {
      continue;
    }
    const sources = topicSources.get(article.topicKey) ?? new Map<string, string>();
    sources.set(article.sourceName, article.url);
    topicSources.set(article.topicKey, sources);
  }

  return articles.map((article) => ({
    ...article,
    relatedSources: article.topicKey
      ? [...(topicSources.get(article.topicKey) ?? new Map([[article.sourceName, article.url]])).entries()].map(([name, url]) => ({ name, url }))
      : [{ name: article.sourceName, url: article.url }]
  }));
}

function mergeTopicDuplicates(articles: RawArticle[]) {
  const groups = new Map<string, RawArticle[]>();
  for (const article of articles) {
    const key = article.topicKey || article.title;
    const group = groups.get(key) ?? [];
    group.push(article);
    groups.set(key, group);
  }

  const mergedArticles: RawArticle[] = [];
  const duplicateCandidates: Array<{ topicKey: string; titles: string[]; sources: string[] }> = [];
  let mergedTopicCount = 0;

  for (const [topicKey, group] of groups.entries()) {
    const relatedSources = dedupeSourceRefs(group.flatMap((article) => article.relatedSources ?? [{ name: article.sourceName, url: article.url }]));
    const representative = [...group].sort((a, b) => (b.newsworthinessScore ?? 0) - (a.newsworthinessScore ?? 0))[0];
    mergedArticles.push({
      ...representative,
      relatedSources
    });

    if (group.length > 1) {
      mergedTopicCount += group.length - 1;
      duplicateCandidates.push({
        topicKey,
        titles: group.map((article) => article.title),
        sources: [...new Set(group.map((article) => article.sourceName))]
      });
    }
  }

  return { articles: mergedArticles, duplicateCandidates, mergedTopicCount };
}

function dedupeSourceRefs(sources: NonNullable<RawArticle["relatedSources"]>) {
  const byName = new Map<string, string | undefined>();
  for (const source of sources) {
    if (!byName.has(source.name)) {
      byName.set(source.name, source.url);
    }
  }
  return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

function selectArticlesForAi(articles: RawArticle[], maxArticles: number, maxPerSource: number) {
  const selected: RawArticle[] = [];
  const groupedArticles = new Map<FeedCategory, RawArticle[]>();
  for (const article of articles) {
    const category = article.feedCategory ?? "その他";
    const group = groupedArticles.get(category) ?? [];
    group.push(article);
    groupedArticles.set(category, group);
  }

  for (const [category, group] of groupedArticles.entries()) {
    groupedArticles.set(
      category,
      [...group].sort((a, b) => (b.newsworthinessScore ?? 0) - (a.newsworthinessScore ?? 0))
    );
  }

  const categories: FeedCategory[] = ["映画", "ドラマ・配信", "芸能・俳優", "業界動向", "公式発表", "海外中国映画祭・文化交流", "その他"];
  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<FeedCategory, number>();
  let lowPriorityCount = 0;
  let cursor = 0;

  while (selected.length < maxArticles) {
    let addedInRound = false;

    for (const category of categories) {
      if (selected.length >= maxArticles) {
        break;
      }

      const categoryLimit = CATEGORY_LIMITS[category] ?? 1;
      const currentCategoryCount = categoryCounts.get(category) ?? 0;
      if (currentCategoryCount >= categoryLimit) {
        continue;
      }

      const group = groupedArticles.get(category) ?? [];
      const article = findNextAllowedArticle(group, cursor, sourceCounts, maxPerSource, lowPriorityCount);
      if (!article) {
        continue;
      }

      selected.push(article);
      sourceCounts.set(article.sourceName, (sourceCounts.get(article.sourceName) ?? 0) + 1);
      categoryCounts.set(category, currentCategoryCount + 1);
      if (article.isLowPriority) {
        lowPriorityCount += 1;
      }
      addedInRound = true;
    }

    if (!addedInRound) {
      break;
    }

    cursor += 1;
  }

  return selected;
}

function findNextAllowedArticle(group: RawArticle[], cursor: number, sourceCounts: Map<string, number>, maxPerSource: number, lowPriorityCount: number) {
  for (let index = cursor; index < group.length; index += 1) {
    const article = group[index];
    if ((sourceCounts.get(article.sourceName) ?? 0) >= maxPerSource) {
      continue;
    }
    if (article.isLowPriority && lowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) {
      continue;
    }
    return article;
  }
  return undefined;
}

function isTooThinForPublishing(article: RawArticle) {
  const rawContentLength = article.rawContentLength ?? 0;
  if (article.articleType === "official_announcement" || article.reliability === "A") {
    return rawContentLength < MIN_OFFICIAL_RAW_CONTENT_LENGTH;
  }
  return rawContentLength < MIN_RAW_CONTENT_LENGTH;
}

function enrichDiagnostics(diagnostics: SourceDiagnostic[], dedupedArticles: RawArticle[], selectedArticles: RawArticle[]) {
  const dedupedCounts = countBySource(dedupedArticles);
  const selectedCounts = countBySource(selectedArticles);

  return diagnostics
    .map((diagnostic) => ({
      ...diagnostic,
      dedupedCount: dedupedCounts.get(diagnostic.sourceName) ?? 0,
      selectedForAiCount: selectedCounts.get(diagnostic.sourceName) ?? 0
    }))
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName, "ja"));
}

function countBySource(articles: RawArticle[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    counts.set(article.sourceName, (counts.get(article.sourceName) ?? 0) + 1);
  }
  return counts;
}

function logSourceDiagnostics(diagnostics: SourceDiagnostic[]) {
  console.log("");
  console.log("source別取得診断");
  for (const diagnostic of diagnostics) {
    console.log(`- ${diagnostic.sourceName}`);
    console.log(`  取得件数: ${diagnostic.fetchedCount}`);
    console.log(`  excludeUrlPatterns除外: ${diagnostic.excludedByPatternCount}`);
    console.log(`  重複除去後: ${diagnostic.dedupedCount}`);
    console.log(`  AI処理対象: ${diagnostic.selectedForAiCount}`);
    console.log(`  エラー: ${diagnostic.error ?? "なし"}`);
    console.log(`  代表タイトル: ${diagnostic.sampleTitles.length ? diagnostic.sampleTitles.join(" / ") : "なし"}`);
  }
}

function logArticleTypeCounts(articles: RawArticle[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    const type = article.articleType ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  console.log("");
  console.log("articleType別件数");
  for (const [type, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${type}: ${count}件`);
  }
}

function logMetadataCounts(articles: RawArticle[]) {
  logFieldCounts("badge別件数", articles.map((article) => article.badge ?? "NEWS"));
  logFieldCounts("source_type別件数", articles.map((article) => article.sourceType ?? "media_report"));
  logFieldCounts("freshness_label別件数", articles.map((article) => article.freshnessLabel ?? "unknown"));

  console.log("");
  console.log("newsworthiness_score 上位記事");
  for (const article of [...articles].sort((a, b) => (b.newsworthinessScore ?? 0) - (a.newsworthinessScore ?? 0)).slice(0, 8)) {
    console.log(`- ${article.newsworthinessScore ?? 0}: ${article.title}`);
  }
}

function logFieldCounts(title: string, values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  console.log("");
  console.log(title);
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${value}: ${count}件`);
  }
}

function logDuplicateCandidates(candidates: Array<{ topicKey: string; titles: string[]; sources: string[] }>) {
  console.log("");
  console.log(`重複候補: ${candidates.length}件`);
  for (const candidate of candidates) {
    console.log(`- ${candidate.topicKey}: ${candidate.sources.join(" / ")}`);
    for (const title of candidate.titles.slice(0, 3)) {
      console.log(`  - ${title}`);
    }
  }
}

function logExclusions(title: string, exclusions: Array<{ title: string; type: ArticleType; reason: string }>) {
  console.log("");
  console.log(`${title}: ${exclusions.length}件`);
  for (const exclusion of exclusions) {
    console.log(`- 除外: ${exclusion.reason} - ${exclusion.title}`);
  }
}

function logFinalSourceDistribution(articles: RawArticle[], heading = "最終AI処理対象のsource配分") {
  const counts = [...countBySource(articles).entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));

  console.log("");
  console.log(heading);
  if (!counts.length) {
    console.log("- なし");
    return;
  }

  for (const [sourceName, count] of counts) {
    console.log(`- ${sourceName}: ${count}件`);
  }
}

function logFinalCategoryDistribution(articles: RawArticle[], heading: string) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    const category = article.feedCategory ?? article.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  console.log("");
  console.log(heading);
  if (!counts.size) {
    console.log("- なし");
    return;
  }

  for (const [category, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${category}: ${count}件`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`実行に失敗しました: ${message}`);
  process.exitCode = 1;
});
