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
    editorial_value?: { enabled: boolean; llm: string; candidates: Array<{ topic_key: string; axes: Record<string, { score: number; reason: string; angle_hint?: string }>; total: number; caps: string[]; result: string }> };
    publication_history?: { loaded_days: string[]; entry_count: number; matches: Array<{ topic_key: string; matched_date: string; matched_key: string; substantive_update: string; decision: string }> };
    official_only?: { limit: number; used: string[]; excluded: string[] };
    comment_diversity?: { openings: Array<{ topic_key: string; opening: string }>; regenerated_opening: string[]; regenerated_paraphrase: string[] };
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
  console.log("\n## Editorial value score");
  console.log(`- enabled: ${trace.editorial_value?.enabled ?? false}`);
  console.log(`- llm: ${trace.editorial_value?.llm ?? "n/a"}`);
  for (const item of trace.editorial_value?.candidates ?? []) {
    const axes = Object.entries(item.axes).map(([name, value]) => `${name}=${value.score} (${value.reason})`).join(" / ");
    console.log(`- ${item.topic_key}: ${item.total}/10 [${item.result}] ${axes} caps=${item.caps.join(",") || "none"}`);
  }
  console.log("\n## Publication history");
  console.log(`- loaded_days: ${trace.publication_history?.loaded_days.join(", ") || "none"}`);
  console.log(`- entry_count: ${trace.publication_history?.entry_count ?? 0}`);
  for (const match of trace.publication_history?.matches ?? []) {
    console.log(`- ${match.topic_key} <= ${match.matched_date}/${match.matched_key}: ${match.substantive_update} -> ${match.decision}`);
  }
  console.log("\n## Official-only");
  console.log(`- limit: ${trace.official_only?.limit ?? 1}`);
  console.log(`- used: ${trace.official_only?.used.join(", ") || "none"}`);
  console.log(`- excluded: ${trace.official_only?.excluded.join(", ") || "none"}`);
  console.log("\n## Comment diversity");
  const openingCounts = new Map<string, number>();
  for (const item of trace.comment_diversity?.openings ?? []) openingCounts.set(item.opening, (openingCounts.get(item.opening) ?? 0) + 1);
  for (const item of trace.comment_diversity?.openings ?? []) console.log(`- ${item.topic_key}: ${item.opening}${(openingCounts.get(item.opening) ?? 0) > 1 ? " [duplicate]" : ""}`);
  const paraphraseWarnings = articles.flatMap((article) => article.generationMeta?.claim_check?.violations.filter((violation) => violation.rule === "comment_paraphrase").map(() => article.topic?.topic_key ?? "") ?? []);
  console.log(`- regenerated_opening: ${trace.comment_diversity?.regenerated_opening.join(", ") || "none"}`);
  console.log(`- regenerated_paraphrase: ${trace.comment_diversity?.regenerated_paraphrase.join(", ") || "none"}`);
  console.log(`- paraphrase_warning: ${paraphraseWarnings.join(", ") || "none"}`);
}

main().catch((error) => {
  console.error(`quality report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
