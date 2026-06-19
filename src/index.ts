import "dotenv/config";
import { dedupeArticles } from "./dedupe.js";
import { fetchAllSources, loadSources } from "./fetchSources.js";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { describeError, getGeminiEnvStatus, summarizeWithGemini } from "./summarizeWithGemini.js";
import type { ProcessedArticle } from "./types.js";

async function main() {
  const maxArticles = Number(process.env.MAX_ARTICLES || 8);
  const sources = await loadSources();
  const geminiEnv = getGeminiEnvStatus();

  console.log(`収集元: ${sources.length}件`);
  console.log(`GEMINI_API_KEY: ${geminiEnv.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`GEMINI_MODEL: ${geminiEnv.model}`);

  const { articles, errors } = await fetchAllSources(sources);
  const dedupedArticles = dedupeArticles(articles).slice(0, maxArticles);
  const processed: ProcessedArticle[] = [];
  const aiErrors: string[] = [];

  for (const article of dedupedArticles) {
    try {
      console.log(`AI処理中: ${article.title}`);
      const summary = await summarizeWithGemini(article);
      processed.push({ raw: article, summary });
    } catch (error) {
      const message = describeError(error);
      aiErrors.push(`${article.title}: ${message}`);
      processed.push({ raw: article, aiError: message });
      console.error(`AI処理エラー: ${article.title}: ${message}`);
    }
  }

  const outputPath = await renderMarkdownFile(processed);

  console.log("");
  console.log("実行結果");
  console.log(`- 取得した記事数: ${articles.length}`);
  console.log(`- 重複除去後の記事数: ${dedupedArticles.length}`);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`実行に失敗しました: ${message}`);
  process.exitCode = 1;
});
