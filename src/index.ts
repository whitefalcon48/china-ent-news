import "dotenv/config";
import { classifyArticle, isPublishableType, loadFilterConfig } from "./classifyArticle.js";
import { dedupeArticles } from "./dedupe.js";
import { fetchAllSources, loadSources } from "./fetchSources.js";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { describeError, getAiProvider, getProviderEnvStatus, summarizeArticle } from "./summarizeWithGemini.js";
import type { ArticleType, ProcessedArticle, RawArticle, SourceDiagnostic } from "./types.js";

const MAX_ARTICLES_PER_SOURCE = 3;

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
  const preAiExclusions = classifiedArticles
    .filter((article) => article.skipReason || !isPublishableType(article.articleType ?? "unknown"))
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: article.skipReason || article.articleType || "not_publishable"
    }));
  const eligibleArticles = classifiedArticles.filter((article) => !article.skipReason && isPublishableType(article.articleType ?? "unknown"));
  const selectedArticles = selectArticlesForAi(eligibleArticles, maxArticles, MAX_ARTICLES_PER_SOURCE);
  const enrichedDiagnostics = enrichDiagnostics(diagnostics, dedupedArticles, selectedArticles);
  const processed: ProcessedArticle[] = [];
  const aiErrors: string[] = [];
  const postAiExclusions: Array<{ title: string; type: ArticleType; reason: string }> = [];

  logSourceDiagnostics(enrichedDiagnostics);
  logArticleTypeCounts(classifiedArticles);
  logExclusions("除外記事", preAiExclusions);
  console.log(`topic_key生成件数: ${new Set(classifiedArticles.map((article) => article.topicKey).filter(Boolean)).size}`);
  logFinalSourceDistribution(selectedArticles);

  for (const article of selectedArticles) {
    try {
      console.log(`AI処理中: ${article.title}`);
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

  console.log("");
  console.log("実行結果");
  console.log(`- 取得した記事数: ${articles.length}`);
  console.log(`- 重複除去後の記事数: ${dedupedArticles.length}`);
  console.log(`- 除外件数: ${preAiExclusions.length + postAiExclusions.length}`);
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

function attachRelatedSources(articles: RawArticle[]) {
  const topicSources = new Map<string, Set<string>>();
  for (const article of articles) {
    if (!article.topicKey) {
      continue;
    }
    const sources = topicSources.get(article.topicKey) ?? new Set<string>();
    sources.add(article.sourceName);
    topicSources.set(article.topicKey, sources);
  }

  return articles.map((article) => ({
    ...article,
    relatedSources: article.topicKey ? [...(topicSources.get(article.topicKey) ?? new Set([article.sourceName]))] : [article.sourceName]
  }));
}

function selectArticlesForAi(articles: RawArticle[], maxArticles: number, maxPerSource: number) {
  const selected: RawArticle[] = [];
  const groupedArticles = new Map<string, RawArticle[]>();
  for (const article of articles) {
    const group = groupedArticles.get(article.sourceName) ?? [];
    group.push(article);
    groupedArticles.set(article.sourceName, group);
  }

  const sourceNames = [...groupedArticles.keys()];
  const sourceCounts = new Map<string, number>();
  let cursor = 0;

  while (selected.length < maxArticles) {
    let addedInRound = false;

    for (const sourceName of sourceNames) {
      if (selected.length >= maxArticles) {
        break;
      }

      const currentCount = sourceCounts.get(sourceName) ?? 0;
      if (currentCount >= maxPerSource) {
        continue;
      }

      const group = groupedArticles.get(sourceName) ?? [];
      const article = group[cursor];
      if (!article) {
        continue;
      }

      selected.push(article);
      sourceCounts.set(sourceName, currentCount + 1);
      addedInRound = true;
    }

    if (!addedInRound) {
      break;
    }

    cursor += 1;
  }

  return selected;
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`実行に失敗しました: ${message}`);
  process.exitCode = 1;
});
