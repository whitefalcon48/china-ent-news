import fs from "node:fs/promises";
import path from "node:path";
import type { AiProvider, FreshnessLabel, ProcessedArticle, RawArticle } from "./types.js";

type TraceFreshness = "fresh" | "stale" | "old" | "unknown";
type TracePriority = "通常" | "低優先";

type TraceCandidate = {
  source: string;
  title: string;
  url: string;
  published_at: string;
  freshness: TraceFreshness;
  priority: TracePriority;
};

type SelectionTrace = {
  date: string;
  provider: AiProvider;
  candidate_pool: TraceCandidate[];
  deepseek_input: {
    count: number;
    items: TraceCandidate[];
  };
  output_count_instruction: string | null;
  final_output: Array<{
    output_title: string;
    input_title: string;
    input_url: string;
    source: string;
    matched_by: "raw_article";
  }>;
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
  outputCountInstruction: string | null;
}) {
  const deepseekInputKeys = new Set(args.deepseekInput.map(candidateKey));
  const candidatePool = args.candidatePool.map(toTraceCandidate);

  const trace: SelectionTrace = {
    date: args.date ?? today(),
    provider: args.provider,
    candidate_pool: candidatePool,
    deepseek_input: {
      count: args.deepseekInput.length,
      items: args.deepseekInput.map(toTraceCandidate)
    },
    output_count_instruction: args.outputCountInstruction,
    final_output: args.processed
      .filter((article) => article.summary)
      .map((article) => ({
        output_title: article.summary?.title_ja || article.raw.title,
        input_title: article.raw.title,
        input_url: article.raw.url,
        source: article.raw.sourceName,
        matched_by: "raw_article" as const
      })),
    dropped: args.candidatePool
      .filter((article) => !deepseekInputKeys.has(candidateKey(article)))
      .map((article) => ({
        ...toTraceCandidate(article),
        reason: args.droppedReasons.get(candidateKey(article)) ?? "not_in_deepseek_input"
      }))
  };

  return trace;
}

export async function writeSelectionTraceFile(trace: SelectionTrace) {
  const outputPath = path.resolve("output", `selection_trace_${trace.date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return outputPath;
}

function toTraceCandidate(article: RawArticle): TraceCandidate {
  return {
    source: article.sourceName,
    title: article.title,
    url: article.url,
    published_at: article.publishedDate || article.publishedAt || "",
    freshness: toTraceFreshness(article.freshnessLabel),
    priority: article.isLowPriority ? "低優先" : "通常"
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