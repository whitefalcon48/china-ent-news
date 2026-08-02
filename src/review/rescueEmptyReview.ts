import fs from "node:fs/promises";
import path from "node:path";
import { selectEditorialReviewRescue, type EditorialReviewRescue, type EditorialValueAssessment } from "../editorialValue.js";
import { createLlmCallBudget } from "../llmCallBudget.js";
import { getAiProvider, summarizeTopic } from "../summarizeWithGemini.js";
import { createTermExpansionSession } from "../termExplainExpansion.js";
import type { FactLedger, ProcessedArticle, RawArticle, TopicCandidate } from "../types.js";

type StoredTrace = {
  editorial_value?: { candidates?: EditorialValueAssessment[]; review_rescue?: EditorialReviewRescue };
  topic_selection?: { selected?: unknown[] };
  claim_check?: unknown[];
  final_output_count?: number;
  final_output?: unknown[];
  llm_call_budget?: { limit: number; used: number };
  [key: string]: unknown;
};

export type StoredRescueSelection = {
  rescue: EditorialReviewRescue;
  topics: TopicCandidate[];
  missing_topic_keys: string[];
};

export function selectStoredReviewRescue(trace: StoredTrace, candidates: TopicCandidate[], excludedTopicKeys = new Set<string>()): StoredRescueSelection {
  const assessments = (trace.editorial_value?.candidates ?? []).filter((assessment) => !excludedTopicKeys.has(assessment.topic_key));
  const rescue = selectEditorialReviewRescue(assessments, { enabled: true, threshold: 6, limit: 3 });
  const byKey = new Map(candidates.map((topic) => [topic.topic_key, topic]));
  const topics = rescue.selected_topic_keys.flatMap((topicKey) => {
    const topic = byKey.get(topicKey);
    return topic ? [topic] : [];
  });
  return {
    rescue,
    topics,
    missing_topic_keys: rescue.selected_topic_keys.filter((topicKey) => !byKey.has(topicKey))
  };
}

export async function rescueEmptyReview(directory: string, date: string): Promise<
  | { ok: true; articles: ProcessedArticle[]; rescue: EditorialReviewRescue }
  | { ok: false; message: string }
> {
  const articlePath = await findFile(directory, /^articles_\d{4}-\d{2}-\d{2}\.json$/);
  const topicPath = await findFile(directory, /^topic_candidates_\d{4}-\d{2}-\d{2}\.json$/);
  const tracePath = await findFile(directory, /^selection_trace_\d{4}-\d{2}-\d{2}\.json$/);
  if (!articlePath || !topicPath || !tracePath) return { ok: false, message: "救済再生成に必要な保存データが見つかりません。0件状態は変更していません。" };

  const existingArticles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  if (existingArticles.length) return { ok: false, message: "すでにレビュー記事があるため、救済再生成は実行しませんでした。" };

  const storedCandidates = JSON.parse(await fs.readFile(topicPath, "utf8")) as { topic_candidates?: TopicCandidate[] };
  const trace = JSON.parse(await fs.readFile(tracePath, "utf8")) as StoredTrace;
  const priorTopicKeys = await loadPreviousReviewTopicKeys(path.dirname(directory), date);
  const selection = selectStoredReviewRescue(trace, storedCandidates.topic_candidates ?? [], priorTopicKeys);
  if (!selection.rescue.activated) return { ok: false, message: "保存済みEVSに6点以上かつ7点未満の救済候補がありません。0件状態は変更していません。" };
  if (selection.missing_topic_keys.length) return { ok: false, message: `救済候補の保存データが不足しています（${selection.missing_topic_keys.join("、")}）。0件状態は変更していません。` };

  const budget = createLlmCallBudget();
  const provider = getAiProvider();
  const termExpansionSession = createTermExpansionSession();
  const usedOpenings: string[] = [];
  const generated: ProcessedArticle[] = [];
  try {
    for (const topic of selection.topics) {
      const evidence = restoreEvidence(topic);
      const result = await summarizeTopic(topic, evidence, provider, budget, { usedOpenings, termExpansionSession });
      if (!result.meta.ledger_used || !result.meta.ledger || result.meta.claim_check?.gated_violation_count) {
        throw new Error(`${topic.topic_key}: fact ledger or claim check did not pass`);
      }
      if (result.meta.display_normalization?.residues.length) {
        throw new Error(`${topic.topic_key}: simplified-character residue detected`);
      }
      if (result.meta.comment_stage?.opening) usedOpenings.push(result.meta.comment_stage.opening);
      generated.push({ raw: evidence[0], topic, summary: result.summary, generationMeta: result.meta });
    }
  } catch (error) {
    return { ok: false, message: `救済再生成に失敗しました。0件状態は変更していません。\n\n${error instanceof Error ? error.message : String(error)}` };
  }

  await writeJson(articlePath, generated);
  await updateLedger(directory, date, generated);
  await updateTrace(tracePath, trace, selection.rescue, generated, budget);
  return { ok: true, articles: generated, rescue: selection.rescue };
}

function restoreEvidence(topic: TopicCandidate): RawArticle[] {
  return topic.evidence_articles.map((item) => {
    const text = item.key_points.filter(Boolean).join("\n");
    return {
      title: item.title,
      url: item.url,
      sourceName: item.source_name,
      sourceUrl: item.url,
      category: "救済再生成",
      reliability: item.reliability,
      sourceType: item.source_type,
      publishedDate: item.published_date,
      freshnessLabel: item.freshness_label,
      articleType: item.article_type,
      excerpt: item.key_points.slice(1).join("\n"),
      rawContent: text,
      rawContentLength: text.length,
      topicKey: topic.topic_key
    };
  });
}

async function updateLedger(directory: string, date: string, articles: ProcessedArticle[]) {
  const ledgerPath = await findFile(directory, /^fact_ledger_\d{4}-\d{2}-\d{2}\.json$/) ?? path.join(directory, `fact_ledger_${date}.json`);
  let existing: { date?: string; generated_at?: string; ledgers?: Array<{ topic_key: string; ledger: FactLedger | null; fallback_reason: string }> } = {};
  try {
    existing = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  } catch {
    // A missing ledger is rebuilt from the same saved evidence during rescue.
  }
  const replacements = new Map(articles.map((article) => [article.topic?.topic_key ?? "", {
    topic_key: article.topic?.topic_key ?? "",
    ledger: article.generationMeta?.ledger ?? null,
    fallback_reason: article.generationMeta?.ledger_fallback_reason ?? ""
  }]));
  const preserved = (existing.ledgers ?? []).filter((item) => !replacements.has(item.topic_key));
  await writeJson(ledgerPath, { date, generated_at: new Date().toISOString(), ledgers: [...preserved, ...replacements.values()] });
}

async function updateTrace(tracePath: string, trace: StoredTrace, rescue: EditorialReviewRescue, articles: ProcessedArticle[], budget: { limit: number; used: number }) {
  const selected = articles.map((article) => ({
    topic_key: article.topic?.topic_key ?? "",
    category: article.summary?.category ?? "",
    primary_source: article.raw.sourceName,
    score: trace.editorial_value?.candidates?.find((item) => item.topic_key === article.topic?.topic_key)?.total ?? 0,
    evidence_urls: article.topic?.evidence_articles.map((item) => item.url) ?? [],
    selection_reason: "saved_evs_review_rescue"
  }));
  trace.editorial_value = { ...(trace.editorial_value ?? {}), candidates: trace.editorial_value?.candidates ?? [], review_rescue: rescue };
  trace.topic_selection = { ...(trace.topic_selection ?? {}), selected };
  trace.claim_check = articles.map((article) => ({
    topic_key: article.topic?.topic_key ?? "",
    ledger_used: article.generationMeta?.ledger_used ?? false,
    ledger_fallback_reason: article.generationMeta?.ledger_fallback_reason ?? "",
    violations: article.generationMeta?.claim_check?.violations ?? [],
    action: article.generationMeta?.claim_check?.action ?? "none"
  }));
  trace.final_output_count = articles.length;
  trace.final_output = articles.map((article) => ({ topic_key: article.topic?.topic_key ?? "", title_ja: article.summary?.title_ja ?? article.raw.title }));
  trace.llm_call_budget = budget;
  trace.review_rescue_rebuild = { source: "saved_topic_candidates", generated_at: new Date().toISOString(), selected_topic_keys: rescue.selected_topic_keys };
  await writeJson(tracePath, trace);
}

async function findFile(directory: string, pattern: RegExp) {
  const files = await fs.readdir(directory);
  const name = files.filter((file) => pattern.test(file)).sort().at(-1);
  return name ? path.join(directory, name) : "";
}

async function loadPreviousReviewTopicKeys(dataDir: string, date: string) {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name >= date) continue;
    const articlePath = await findFile(path.join(dataDir, entry.name), /^articles_\d{4}-\d{2}-\d{2}\.json$/);
    if (!articlePath) continue;
    try {
      const articles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
      for (const article of articles) {
        const topicKey = article.topic?.topic_key ?? article.summary?.topic_key;
        if (topicKey) keys.add(topicKey);
      }
    } catch {
      // One historic data directory must not block the rescue for another date.
    }
  }
  return keys;
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
