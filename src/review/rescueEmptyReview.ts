import fs from "node:fs/promises";
import path from "node:path";
import { selectEditorialReviewRescue, type EditorialReviewRescue, type EditorialValueAssessment } from "../editorialValue.js";
import { createLlmCallBudget } from "../llmCallBudget.js";
import { getAiProvider, summarizeTopic } from "../summarizeWithGemini.js";
import { createTermExpansionSession } from "../termExplainExpansion.js";
import { expandTopicSources } from "../expandSources.js";
import type { FactLedger, ProcessedArticle, RawArticle, SourceExpansionResult, TopicCandidate } from "../types.js";

type StoredTrace = {
  editorial_value?: { candidates?: EditorialValueAssessment[]; review_rescue?: EditorialReviewRescue };
  topic_selection?: { selected?: unknown[]; failed?: Array<{ topic_key?: string }> };
  generation_status?: { status?: "succeeded" | "no_candidate" | "generation_failed"; failed_topic_keys?: string[] };
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

export type RescueGenerationFailure = { topic_key: string; reason: string };

export function getCurrentReviewTopicKeys(articles: ProcessedArticle[]) {
  return new Set(
    articles.flatMap((article) => {
      const topicKey = article.topic?.topic_key ?? article.summary?.topic_key;
      return topicKey ? [topicKey] : [];
    })
  );
}

export function selectStoredReviewRescue(trace: StoredTrace, candidates: TopicCandidate[], excludedTopicKeys = new Set<string>()): StoredRescueSelection {
  const failedTopicKeys = new Set([
    ...(trace.generation_status?.failed_topic_keys ?? []),
    ...(trace.topic_selection?.failed ?? []).flatMap((item) => item.topic_key ? [item.topic_key] : [])
  ]);
  const excluded = new Set([...excludedTopicKeys, ...failedTopicKeys]);
  const assessments = (trace.editorial_value?.candidates ?? []).filter((assessment) => !excluded.has(assessment.topic_key));
  const rescue = selectEditorialReviewRescue(assessments, {
    enabled: true,
    threshold: 6,
    limit: 3,
    allowQualifiedFallback: trace.generation_status?.status === "generation_failed" || failedTopicKeys.size > 0
  });
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
  | { ok: true; articles: ProcessedArticle[]; rescue: EditorialReviewRescue; failures: RescueGenerationFailure[]; sourceRefresh: SourceExpansionResult | null }
  | { ok: false; message: string }
> {
  const articlePath = await findFile(directory, /^articles_\d{4}-\d{2}-\d{2}\.json$/);
  const topicPath = await findFile(directory, /^topic_candidates_\d{4}-\d{2}-\d{2}\.json$/);
  const tracePath = await findFile(directory, /^selection_trace_\d{4}-\d{2}-\d{2}\.json$/);
  if (!articlePath || !topicPath || !tracePath) return { ok: false, message: "救済再生成に必要な保存データが見つかりません。0件状態は変更していません。" };

  const existingArticles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  const storedCandidates = JSON.parse(await fs.readFile(topicPath, "utf8")) as { topic_candidates?: TopicCandidate[] };
  const trace = JSON.parse(await fs.readFile(tracePath, "utf8")) as StoredTrace;
  const priorTopicKeys = await loadPreviousReviewTopicKeys(path.dirname(directory), date);
  const existingTopicKeys = getCurrentReviewTopicKeys(existingArticles);
  let selection = selectStoredReviewRescue(trace, storedCandidates.topic_candidates ?? [], new Set([...priorTopicKeys, ...existingTopicKeys]));
  if (!selection.rescue.activated) return {
    ok: false,
    message: existingArticles.length
      ? "既存のレビュー記事と過去に失敗した候補を除くと、追加で救済できるEVS候補はありません。既存記事は変更していません。"
      : "保存済みEVSに6点以上かつ7点未満の救済候補がありません。0件状態は変更していません。"
  };
  if (selection.missing_topic_keys.length) return { ok: false, message: `救済候補の保存データが不足しています（${selection.missing_topic_keys.join("、")}）。0件状態は変更していません。` };

  const refreshed = await refreshRescueTopics(selection.topics);
  if (refreshed.topicCandidates.length) {
    const refreshedByKey = new Map(refreshed.topicCandidates.map((topic) => [topic.topic_key, topic]));
    selection = { ...selection, topics: selection.topics.map((topic) => refreshedByKey.get(topic.topic_key) ?? topic) };
    await writeRefreshedCandidates(topicPath, storedCandidates, refreshedByKey);
  }

  const budget = createLlmCallBudget();
  const provider = getAiProvider();
  const termExpansionSession = createTermExpansionSession();
  const usedOpenings: string[] = [];
  const generated: ProcessedArticle[] = [];
  const failures: RescueGenerationFailure[] = [];
  for (const topic of selection.topics) {
    try {
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
    } catch (error) {
      failures.push({ topic_key: topic.topic_key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!generated.length) {
    await updateTrace(tracePath, trace, selection.rescue, existingArticles, budget, failures, refreshed.expansion);
    return { ok: false, message: `Rescue attempted ${selection.topics.length} candidates but none passed generation.\n${failures.map((failure) => `- ${failure.topic_key}: ${failure.reason}`).join("\n")}` };
  }
  const articles = [...existingArticles, ...generated];
  await writeJson(articlePath, articles);
  await updateLedger(directory, date, articles);
  await updateTrace(tracePath, trace, selection.rescue, articles, budget, failures, refreshed.expansion);
  return { ok: true, articles, rescue: selection.rescue, failures, sourceRefresh: refreshed.expansion };
}

function restoreEvidence(topic: TopicCandidate): RawArticle[] {
  const root = topic.evidence_articles.map((item) => {
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
      topicKey: topic.topic_key,
      evidenceRole: "root_corroboration" as const
    };
  });
  const related = (topic.related_evidence_articles ?? []).map((item) => {
    const text = item.key_points.filter(Boolean).join("\n");
    return {
      title: item.title,
      url: item.url,
      sourceName: item.source_name,
      sourceUrl: item.url,
      category: "関連角度",
      reliability: item.reliability,
      sourceType: item.source_type,
      publishedDate: item.published_date,
      freshnessLabel: item.freshness_label,
      articleType: item.article_type,
      excerpt: item.key_points.slice(1).join("\n"),
      rawContent: text,
      rawContentLength: text.length,
      topicKey: topic.topic_key,
      evidenceRole: "related_angle" as const,
      angleKind: item.angle_kind
    };
  });
  return [...root, ...related];
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

async function updateTrace(
  tracePath: string,
  trace: StoredTrace,
  rescue: EditorialReviewRescue,
  articles: ProcessedArticle[],
  budget: { limit: number; used: number },
  failures: RescueGenerationFailure[],
  sourceRefresh: SourceExpansionResult | null
) {
  const selected = articles.map((article) => ({
    topic_key: article.topic?.topic_key ?? article.summary?.topic_key ?? "",
    category: article.summary?.category ?? "",
    primary_source: article.raw.sourceName,
    score: trace.editorial_value?.candidates?.find((item) => item.topic_key === (article.topic?.topic_key ?? article.summary?.topic_key))?.total ?? 0,
    evidence_urls: article.topic?.evidence_articles.map((item) => item.url) ?? [],
    selection_reason: "saved_evs_review_rescue"
  }));
  trace.editorial_value = { ...(trace.editorial_value ?? {}), candidates: trace.editorial_value?.candidates ?? [], review_rescue: rescue };
  const failedTopicKeys = new Set([
    ...(trace.generation_status?.failed_topic_keys ?? []),
    ...(trace.topic_selection?.failed ?? []).flatMap((item) => item.topic_key ? [item.topic_key] : []),
    ...failures.map((failure) => failure.topic_key)
  ]);
  trace.topic_selection = {
    ...(trace.topic_selection ?? {}),
    selected,
    failed: [...failedTopicKeys].map((topic_key) => ({ topic_key }))
  };
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
  trace.generation_status = {
    status: articles.length ? "succeeded" : "generation_failed",
    failed_topic_keys: [...failedTopicKeys]
  };
  trace.review_rescue_rebuild = {
    source: "saved_topic_candidates",
    generated_at: new Date().toISOString(),
    selected_topic_keys: rescue.selected_topic_keys,
    generated_topic_keys: articles.map((article) => article.topic?.topic_key ?? ""),
    failures,
    source_refresh: sourceRefresh
  };
  await writeJson(tracePath, trace);
}

async function refreshRescueTopics(topics: TopicCandidate[]) {
  if (!topics.length || !process.env.SERPER_API_KEY?.trim()) {
    return { topicCandidates: topics, expansion: null as SourceExpansionResult | null };
  }
  const result = await expandTopicSources(topics, { forceSerper: true, maxTopics: 3 });
  return { topicCandidates: result.topicCandidates, expansion: result.expansion };
}

async function writeRefreshedCandidates(
  topicPath: string,
  stored: { topic_candidates?: TopicCandidate[]; [key: string]: unknown },
  refreshedByKey: Map<string, TopicCandidate>
) {
  const topic_candidates = (stored.topic_candidates ?? []).map((topic) => refreshedByKey.get(topic.topic_key) ?? topic);
  await writeJson(topicPath, { ...stored, topic_candidates });
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
