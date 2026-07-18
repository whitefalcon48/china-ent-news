import fs from "node:fs/promises";
import path from "node:path";
import type { LlmCallBudget } from "./llmCallBudget.js";
import type {
  AiProvider,
  ClaimCheckResult,
  ClaimCheckViolation,
  FeedBadge,
  FreshnessLabel,
  ProcessedArticle,
  PublishPriority,
  RawArticle,
  SourceExpansionResult,
  ToneMode,
  TopicCandidate,
  TopicGenerationMeta
} from "./types.js";

type TraceFreshness = "fresh" | "stale" | "old" | "unknown";
type TracePriority = "通常" | "低優先";

type TraceCandidate = {
  source: string;
  title: string;
  url: string;
  published_at: string;
  freshness: TraceFreshness;
  priority: TracePriority;
  selection_rank: number | null;
  selected_for_deepseek: boolean;
  selection_reason: string;
  not_selected_reason: string;
};

type PublishPriorityCounts = Record<PublishPriority, number>;

export type SourceSelectionDiagnostic = {
  source: string;
  raw_count: number;
  after_url_exclude_count: number;
  after_dedupe_count: number;
  valid_date_count: number;
  fresh_count: number;
  ai_candidate_count: number;
  selected_for_deepseek_count: number;
  main_drop_reason: string;
  date_pipeline_note?: string;
};

type TraceFinalOutput = {
  title_ja: string;
  badge: FeedBadge;
  topic_key: string;
  output_title: string;
  input_title: string;
  input_url: string;
  source: string;
  matched_by: "raw_article" | "topic";
  publish_priority: PublishPriority;
  publish_reason: string;
};

type SelectionTrace = {
  date: string;
  provider: AiProvider;
  candidate_pool: TraceCandidate[];
  topic_candidates_count: number;
  topic_candidates: TopicCandidate[];
  dropped_topics: Array<TopicCandidate & { reason: string }>;
  topic_layer_note: string;
  topic_selection: {
    enabled: boolean;
    selected: Array<{
      topic_key: string;
      category: string;
      primary_source: string;
      score: number;
      evidence_urls: string[];
      selection_reason: string;
    }>;
    dropped: Array<{ topic_key: string; reason: string }>;
    failed: Array<{ topic_key: string; stage: "ai_error" | "post_ai_exclude" | "claim_check_gate"; reason: string }>;
    backfilled: string[];
  };
  claim_check: Array<{
    topic_key: string;
    ledger_used: boolean;
    ledger_fallback_reason: string;
    violations: ClaimCheckViolation[];
    action: ClaimCheckResult["action"];
    tone_mode?: ToneMode;
    comment_stage?: TopicGenerationMeta["comment_stage"];
  }>;
  information_gate: {
    enabled: boolean;
    evaluated: number;
    excluded: number;
    excluded_topics: Array<{ topic_key: string; reasons: string[] }>;
  };
  llm_call_budget: {
    limit: number;
    used: number;
  };
  source_expansion: SourceExpansionResult | null;
  deepseek_input: {
    count: number;
    items: TraceCandidate[];
  };
  output_count_instruction: string | null;
  final_output_count: number;
  publish_priority_counts: PublishPriorityCounts;
  non_official_source_diagnostics: SourceSelectionDiagnostic[];
  final_output: TraceFinalOutput[];
  dropped: Array<TraceCandidate & { reason: string }>;
};

export function candidateKey(article: RawArticle) {
  return article.url || `${article.sourceName}:${article.title}`;
}

export function buildSelectionTrace(args: {
  date?: string;
  provider: AiProvider;
  candidatePool: RawArticle[];
  deepseekInput: RawArticle[];
  processed: ProcessedArticle[];
  droppedReasons: Map<string, string>;
  selectionReasons: Map<string, string>;
  outputCountInstruction: string | null;
  nonOfficialSourceDiagnostics?: SourceSelectionDiagnostic[];
  topicCandidates?: TopicCandidate[];
  droppedTopics?: Array<TopicCandidate & { reason: string }>;
  topicLayerNote?: string;
  sourceExpansion?: SourceExpansionResult;
  topicSelection?: SelectionTrace["topic_selection"];
  llmCallBudget?: LlmCallBudget;
  informationGate?: SelectionTrace["information_gate"];
}) {
  const deepseekInputKeys = new Set(args.deepseekInput.map(candidateKey));
  const selectionRanks = new Map<string, number>();
  args.deepseekInput.forEach((article, index) => {
    selectionRanks.set(candidateKey(article), index + 1);
  });

  const candidatePool = args.candidatePool.map((article) =>
    toTraceCandidate(article, {
      selected: deepseekInputKeys.has(candidateKey(article)),
      selectionRank: selectionRanks.get(candidateKey(article)) ?? null,
      selectionReason: args.selectionReasons.get(candidateKey(article)) ?? "",
      notSelectedReason: args.droppedReasons.get(candidateKey(article)) ?? ""
    })
  );

  const finalOutput = args.processed
    .filter((article) => article.summary)
    .map((article) => ({
      title_ja: article.summary?.title_ja || article.raw.title,
      badge: article.summary?.badge ?? article.raw.badge ?? "NEWS",
      topic_key: article.topic?.topic_key ?? article.summary?.topic_key ?? article.raw.topicKey ?? "",
      output_title: article.summary?.title_ja || article.raw.title,
      input_title: article.raw.title,
      input_url: article.raw.url,
      source: article.raw.sourceName,
      matched_by: article.topic ? ("topic" as const) : ("raw_article" as const),
      publish_priority: article.summary?.publish_priority ?? "medium",
      publish_reason: article.summary?.publish_reason || inferPublishReason(article)
    }));

  const trace: SelectionTrace = {
    date: args.date ?? today(),
    provider: args.provider,
    candidate_pool: candidatePool,
    topic_candidates_count: args.topicCandidates?.length ?? 0,
    topic_candidates: args.topicCandidates ?? [],
    dropped_topics: args.droppedTopics ?? [],
    topic_layer_note:
      args.topicLayerNote ??
      "MVP topic layer is diagnostic only. DeepSeek input and Markdown output still use article-level candidates.",
    topic_selection: args.topicSelection ?? { enabled: false, selected: [], dropped: [], failed: [], backfilled: [] },
    claim_check: args.processed
      .filter((article) => article.generationMeta)
      .map((article) => ({
        topic_key: article.generationMeta?.topic_key ?? article.topic?.topic_key ?? "",
        ledger_used: article.generationMeta?.ledger_used ?? false,
        ledger_fallback_reason: article.generationMeta?.ledger_fallback_reason ?? "",
        violations: article.generationMeta?.claim_check?.violations ?? [],
        action: article.generationMeta?.claim_check?.action ?? "none",
        tone_mode: article.generationMeta?.tone_mode,
        comment_stage: article.generationMeta?.comment_stage
      })),
    information_gate: args.informationGate ?? { enabled: false, evaluated: 0, excluded: 0, excluded_topics: [] },
    llm_call_budget: {
      limit: args.llmCallBudget?.limit ?? 0,
      used: args.llmCallBudget?.used ?? 0
    },
    source_expansion: args.sourceExpansion ?? null,
    deepseek_input: {
      count: args.deepseekInput.length,
      items: args.deepseekInput.map((article) =>
        toTraceCandidate(article, {
          selected: true,
          selectionRank: selectionRanks.get(candidateKey(article)) ?? null,
          selectionReason: args.selectionReasons.get(candidateKey(article)) ?? "selected_for_deepseek_input",
          notSelectedReason: ""
        })
      )
    },
    output_count_instruction: args.outputCountInstruction,
    final_output_count: finalOutput.length,
    publish_priority_counts: countPublishPriorities(finalOutput),
    non_official_source_diagnostics: args.nonOfficialSourceDiagnostics ?? [],
    final_output: finalOutput,
    dropped: args.candidatePool
      .filter((article) => !deepseekInputKeys.has(candidateKey(article)))
      .map((article) => {
        const reason = args.droppedReasons.get(candidateKey(article)) ?? "not_in_deepseek_input";
        return {
          ...toTraceCandidate(article, {
            selected: false,
            selectionRank: null,
            selectionReason: "",
            notSelectedReason: reason
          }),
          reason
        };
      })
  };

  return trace;
}

export async function writeSelectionTraceFile(trace: SelectionTrace) {
  const outputPath = path.resolve("output", `selection_trace_${trace.date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return outputPath;
}

function countPublishPriorities(finalOutput: TraceFinalOutput[]): PublishPriorityCounts {
  const counts: PublishPriorityCounts = { high: 0, medium: 0, low: 0 };
  for (const item of finalOutput) {
    counts[item.publish_priority] += 1;
  }
  return counts;
}

function inferPublishReason(article: ProcessedArticle) {
  const summary = article.summary;
  if (!summary) {
    return "";
  }
  if (summary.source_type === "official" || summary.source_type === "pr_like") {
    return "official source; useful when it shows policy, production, or industry environment changes";
  }
  if (summary.article_type === "data_report") {
    return "data point that helps read market or industry movement";
  }
  if (summary.japan_gap === "high" || summary.context_value === "high") {
    return "strong fit with the project focus on China-local entertainment context";
  }
  return "publishable reference item";
}

function toTraceCandidate(
  article: RawArticle,
  meta: {
    selected: boolean;
    selectionRank: number | null;
    selectionReason: string;
    notSelectedReason: string;
  }
): TraceCandidate {
  return {
    source: article.sourceName,
    title: article.title,
    url: article.url,
    published_at: article.publishedDate || article.publishedAt || "",
    freshness: toTraceFreshness(article.freshnessLabel),
    priority: article.isLowPriority ? "低優先" : "通常",
    selection_rank: meta.selectionRank,
    selected_for_deepseek: meta.selected,
    selection_reason: meta.selectionReason,
    not_selected_reason: meta.notSelectedReason
  };
}

function toTraceFreshness(label: FreshnessLabel | undefined): TraceFreshness {
  if (label === "today" || label === "yesterday" || label === "recent") {
    return "fresh";
  }
  if (label === "stale") {
    return "stale";
  }
  if (label === "old") {
    return "old";
  }
  return "unknown";
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
