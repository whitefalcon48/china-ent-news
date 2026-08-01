import fs from "node:fs/promises";
import path from "node:path";
import { createLlmCallBudget } from "./llmCallBudget.js";
import { summarizeTopic } from "./summarizeWithGemini.js";
import type { CompareFixture } from "./compareFixture.js";
import type { AiProvider, ProcessedArticle } from "./types.js";

type ModelConfig = {
  name: "A" | "B" | "C";
  base: { provider: AiProvider; model: string };
  ledger: { provider: AiProvider; model: string };
  comment: { provider: AiProvider; model: string };
};

const CONFIGS: ModelConfig[] = [
  { name: "A", base: { provider: "deepseek", model: "deepseek-v4-flash" }, ledger: { provider: "deepseek", model: "deepseek-v4-flash" }, comment: { provider: "deepseek", model: "deepseek-v4-flash" } },
  { name: "B", base: { provider: "deepseek", model: "deepseek-v4-flash" }, ledger: { provider: "deepseek", model: "deepseek-v4-pro" }, comment: { provider: "deepseek", model: "deepseek-v4-pro" } },
  { name: "C", base: { provider: "deepseek", model: "deepseek-v4-flash" }, ledger: { provider: "deepseek", model: "deepseek-v4-pro" }, comment: { provider: "gemini", model: "gemini-3.5-flash" } }
];

async function main() {
  const fixturePath = resolveFixturePath(process.argv[2]);
  const fixtureText = await fs.readFile(fixturePath, "utf8");
  const fixture = JSON.parse(fixtureText) as CompareFixture;
  const fixtureSnapshot = JSON.stringify(fixture);
  const shuffled = shuffle([...CONFIGS]);
  const outputDir = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output");
  await fs.mkdir(outputDir, { recursive: true });
  const key: Record<string, ModelConfig> = {};
  const budget = createLlmCallBudget(Number(process.env.LLM_CALL_BUDGET || 120));

  const previous = captureRoutingEnv();
  process.env.TERM_EXPLAIN_EXPANSION = "false";
  try {
    for (let index = 0; index < shuffled.length; index += 1) {
      const combo = `combo-${index + 1}`;
      const config = shuffled[index];
      key[combo] = config;
      applyRoutingEnv(config);
      const processed: ProcessedArticle[] = [];
      const errors: Array<{ topic_key: string; error: string }> = [];
      for (const item of fixture.topics) {
        try {
          const result = process.env.MODEL_COMPARE_MOCK === "true"
            ? mockSummary(item.topic.topic_key, item.evidence[0]?.title || "テスト記事")
            : await summarizeTopic(item.topic, item.evidence, config.base.provider, budget);
          processed.push({ raw: item.evidence[0], topic: item.topic, summary: result.summary, generationMeta: result.meta });
        } catch (error) {
          const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
          errors.push({ topic_key: item.topic.topic_key, error: detail });
          processed.push({ raw: item.evidence[0], topic: item.topic, aiError: detail });
        }
      }
      const machineChecks = checkOutputs(processed, fixtureSnapshot === JSON.stringify(fixture), errors);
      const jsonPath = path.join(outputDir, `model_compare_${fixture.date}_${combo}.json`);
      const markdownPath = path.join(outputDir, `model_compare_${fixture.date}_${combo}.md`);
      await fs.writeFile(jsonPath, `${JSON.stringify({ combo, machine_checks: machineChecks, errors, articles: processed }, null, 2)}\n`, "utf8");
      await fs.writeFile(markdownPath, renderComparisonMarkdown(combo, processed, machineChecks), "utf8");
    }
  } finally {
    restoreRoutingEnv(previous);
  }
  await fs.writeFile(path.join(outputDir, `model_compare_${fixture.date}_key.json`), `${JSON.stringify(key, null, 2)}\n`, "utf8");
  console.log(`model compare: ${fixture.topics.length} topics x ${CONFIGS.length} configs`);
}

function mockSummary(topicKey: string, title: string): Awaited<ReturnType<typeof summarizeTopic>> {
  const summary = {
    title_ja: title,
    badge: "NEWS" as const,
    lead: "比較基盤のローカル検証用記事です。",
    what_happened: "固定fixtureを変更せず、三つの構成を実行します。",
    why_it_matters: "同じ入力を使うので、モデルごとの書き方を公平に比べられます！ここ、大事です！",
    reaction_view: "",
    editor_comment: "",
    japan_context_note: "",
    category: "映画",
    confidence: "B" as const,
    source_type: "media_report" as const,
    published_date: "",
    event_date: "",
    freshness_label: "recent" as const,
    newsworthiness_score: 0,
    japan_visibility: "unknown" as const,
    japan_gap: "unknown" as const,
    context_value: "low" as const,
    sns_heat: "none" as const,
    source_count: 1,
    source_list: [],
    has_official_source: false,
    has_multiple_sources: false,
    has_sns_signal: false,
    article_type: "news_event" as const,
    skip_reason: "",
    verification_status: "",
    topic_key: topicKey,
    main_entities: { people: [], works: [], organizations: [] },
    related_sources: [],
    tags: [],
    publish_priority: "medium" as const,
    publish_reason: "model comparison mock",
    claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
  };
  return {
    summary,
    meta: {
      topic_key: topicKey,
      ledger_used: true,
      ledger_fallback_reason: "",
      ledger: { topic_key: topicKey, claims: [], terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: [] },
      display_normalization: { residues: [] }
    }
  };
}

function checkOutputs(processed: ProcessedArticle[], fixtureUnchanged: boolean, errors: Array<{ topic_key: string; error: string }>) {
  const residues = processed.flatMap((article) => article.generationMeta?.display_normalization?.residues ?? []);
  const editorCommentNonEmpty = processed.filter((article) => article.summary?.editor_comment.trim()).length;
  const invalidClaimRefs = processed.flatMap((article) => {
    const ids = new Set(article.generationMeta?.ledger?.claims.map((claim) => claim.id) ?? []);
    return Object.values(article.summary?.claim_refs ?? {}).flat().filter((ref) => !ids.has(ref));
  });
  const groundingViolations = processed.flatMap((article) => article.generationMeta?.claim_check?.violations.filter((violation) =>
    violation.rule === "comment_number_not_in_ledger" || violation.rule === "comment_entity_not_in_ledger"
  ) ?? []);
  return {
    json_parse_success: errors.length === 0,
    simplified_char_residue_zero: residues.length === 0,
    editor_comment_empty: editorCommentNonEmpty === 0,
    claim_refs_subset: invalidClaimRefs.length === 0,
    comment_grounding_violations_zero: groundingViolations.length === 0,
    fixture_unchanged: fixtureUnchanged,
    details: { errors, residues, editor_comment_non_empty: editorCommentNonEmpty, invalid_claim_refs: invalidClaimRefs, grounding_violations: groundingViolations }
  };
}

function renderComparisonMarkdown(combo: string, processed: ProcessedArticle[], checks: ReturnType<typeof checkOutputs>) {
  const articles = processed.map((article, index) => {
    const summary = article.summary;
    if (!summary) return `## ${index + 1}. ${article.raw.title}\n\n生成失敗: ${article.aiError || "unknown error"}\n`;
    return `## ${index + 1}. ${summary.title_ja}\n\n${summary.lead}\n\n### 何が起きた？\n\n${summary.what_happened}\n\n### ビンタンのひとこと感想\n\n${summary.why_it_matters}\n`;
  }).join("\n");
  return `# Model comparison ${combo}\n\n## Machine checks\n\n\`\`\`json\n${JSON.stringify(checks, null, 2)}\n\`\`\`\n\n${articles}`;
}

function resolveFixturePath(value?: string) {
  if (value) return path.resolve(value);
  const date = process.env.COMPARE_DATE;
  if (!date) throw new Error("fixture path argument or COMPARE_DATE is required");
  const outputPath = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output", `compare_fixture_${date}.json`);
  return outputPath;
}

function shuffle<T>(values: T[]) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function applyRoutingEnv(config: ModelConfig) {
  process.env.DEEPSEEK_MODEL = config.base.model;
  process.env.LEDGER_AI_PROVIDER = config.ledger.provider;
  process.env.LEDGER_AI_MODEL = config.ledger.model;
  process.env.COMMENT_AI_PROVIDER = config.comment.provider;
  process.env.COMMENT_AI_MODEL = config.comment.model;
}

function captureRoutingEnv() {
  return Object.fromEntries(["DEEPSEEK_MODEL", "LEDGER_AI_PROVIDER", "LEDGER_AI_MODEL", "COMMENT_AI_PROVIDER", "COMMENT_AI_MODEL", "TERM_EXPLAIN_EXPANSION"].map((key) => [key, process.env[key]]));
}

function restoreRoutingEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(`model compare failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
