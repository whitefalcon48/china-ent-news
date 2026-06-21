import "dotenv/config";
import { dedupeArticles } from "./dedupe.js";
import { fetchAllSources, loadSources } from "./fetchSources.js";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { describeError, getAiProvider, getProviderEnvStatus, summarizeArticle } from "./summarizeWithGemini.js";
import type { ProcessedArticle, RawArticle, SourceDiagnostic } from "./types.js";

const MAX_ARTICLES_PER_SOURCE = 3;

async function main() {
  const maxArticles = Number(process.env.MAX_ARTICLES || 8);
  const sources = await loadSources();
  const provider = getAiProvider();
  const aiEnv = getProviderEnvStatus(provider);

  console.log(`収集元: ${sources.length}件`);
  console.log(`AI_PROVIDER: ${provider}`);
  console.log(`${provider === "gemini" ? "GEMINI_API_KEY" : "DEEPSEEK_API_KEY"}: ${aiEnv.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`AI_MODEL: ${aiEnv.model}`);

  const { articles, errors, diagnostics } = await fetchAllSources(sources);
  const dedupedArticles = dedupeArticles(articles);
  const selectedArticles = selectArticlesForAi(dedupedArticles, maxArticles, MAX_ARTICLES_PER_SOURCE);
  const enrichedDiagnostics = enrichDiagnostics(diagnostics, dedupedArticles, selectedArticles);
  const processed: ProcessedArticle[] = [];
  const aiErrors: string[] = [];

  logSourceDiagnostics(enrichedDiagnostics);
  logFinalSourceDistribution(selectedArticles);

  for (const article of selectedArticles) {
    try {
      console.log(`AI処理中: ${article.title}`);
      const summary = await summarizeArticle(article, provider);
      processed.push({ raw: article, summary });
    } catch (error) {
      const message = describeError(error);
      aiErrors.push(`${article.title}: ${message}`);
      processed.push({ raw: article, aiError: message });
      console.error(`AI処理エラー: ${article.title}: ${message}`);
    }
  }

  const outputPath = await renderMarkdownFile(processed, provider);

  console.log("");
  console.log("実行結果");
  console.log(`- 取得した記事数: ${articles.length}`);
  console.log(`- 重複除去後の記事数: ${dedupedArticles.length}`);
  console.log(`- AI処理対象の記事数: ${selectedArticles.length}`);
  console.log(`- AI処理した記事数: ${processed.filter((article) => article.summary).length}`);
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

function logFinalSourceDistribution(articles: RawArticle[]) {
  const counts = [...countBySource(articles).entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));

  console.log("");
  console.log("最終AI処理対象のsource配分");
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
