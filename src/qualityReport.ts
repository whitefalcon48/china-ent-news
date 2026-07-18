import fs from "node:fs/promises";
import path from "node:path";
import { loadTerminology } from "./terminology.js";
import type { ProcessedArticle } from "./types.js";

const TEMPLATE_COMMENT = /業界全体に影響を与える可能性|透明性向上につながる可能性|今後の動向(に|を)?(注目|注視|追|見守)|評価のポイントになりそう|新たな指標になるか|目が離せ(ない|ません)|今後注目したい|注目したいところ|注目が集ま(りそう|る)/g;

async function main() {
  const outputDir = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output");
  const names = await fs.readdir(outputDir);
  const articlesFile = names.filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  const traceFile = names.filter((name) => /^selection_trace_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!articlesFile || !traceFile) throw new Error("latest articles/selection trace not found");
  const articles = JSON.parse(await fs.readFile(path.join(outputDir, articlesFile), "utf8")) as ProcessedArticle[];
  const trace = JSON.parse(await fs.readFile(path.join(outputDir, traceFile), "utf8")) as {
    information_gate?: { enabled: boolean; evaluated: number; excluded: number; excluded_topics: Array<{ topic_key: string; reasons: string[] }> };
    llm_call_budget?: { limit: number; used: number };
  };
  const terminology = await loadTerminology();
  const avoid = terminology.preferred_names.flatMap((item) => item.avoid);
  console.log(`# Quality report: ${articlesFile}\n`);
  articles.filter((article) => article.summary).forEach((article, index) => {
    const summary = article.summary!;
    const comments = `${summary.why_it_matters}\n${summary.editor_comment}`;
    const allText = [summary.title_ja, summary.lead, summary.what_happened, summary.why_it_matters, summary.reaction_view, summary.japan_context_note, summary.editor_comment].join("\n");
    const longSentences = (comments.match(/[^。！？!?]+[。！？!?]?/g) || []).filter((sentence) => sentence.replace(/[。！？!?]/g, "").length > 90).length;
    const exclamations = (comments.match(/[！!]/g) || []).length;
    const endingRepetition = (comments.match(/ですね[。！!]/g) || []).length;
    const toneMode = article.generationMeta?.tone_mode || "n/a";
    console.log(`## ${index + 1}. ${summary.title_ja}`);
    console.log(`- tone_mode: ${toneMode}`);
    console.log(`- exclamations: ${exclamations} (${toneMode === "normal" ? (exclamations >= 2 && exclamations <= 4 ? "2-4 ok" : "2-4 out_of_range") : "sober expected 0"})`);
    console.log(`- ending_repetition_desune: ${endingRepetition}`);
    console.log(`- template_comment: ${(comments.match(TEMPLATE_COMMENT) || []).length}`);
    console.log(`- terminology_avoid: ${avoid.filter((term) => allText.includes(term)).join(", ") || "none"}`);
    console.log(`- long_sentence_over_90: ${longSentences}`);
    console.log(`- hedging_kamo_mitai: ${(comments.match(/かも|みたい|のようです/g) || []).length}\n`);
  });
  console.log("## Information gate");
  console.log(JSON.stringify(trace.information_gate || { enabled: false, evaluated: 0, excluded: 0, excluded_topics: [] }, null, 2));
  console.log("\n## LLM call budget");
  console.log(`- used: ${trace.llm_call_budget?.used ?? 0}`);
  console.log(`- limit: ${trace.llm_call_budget?.limit ?? 0}`);
}

main().catch((error) => {
  console.error(`quality report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
