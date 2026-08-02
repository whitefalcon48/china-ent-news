import fs from "node:fs/promises";
import path from "node:path";
import type { TopicCandidate } from "../types.js";
import {
  CANDIDATE_REVIEW_SCHEMA_VERSION,
  SELECTION_FEEDBACK_SCHEMA_VERSION,
  candidateReasonTags,
  type CandidateInterestRating,
  type CandidateRatingDecision,
  type CandidateReasonTag,
  type CandidateReviewInput,
  type CandidateReviewItem,
  type CandidateReviewState,
  type CandidateRiskClass,
  type SelectionFeedbackRecord
} from "./candidateReviewTypes.js";
import { classifyInterestFeatures } from "./interestTags.js";
import { INTEREST_FEATURE_IDS, type SelectionFeedback } from "./types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creates a review snapshot from the ranked topic candidates. This does not
 * alter their selection score and is safe to call before article generation.
 */
export function createCandidateReviewState(candidates: CandidateReviewInput[], date: string, limit = 12): CandidateReviewState {
  if (!DATE_PATTERN.test(date)) throw new Error(`候補レビューの日付が不正です: ${date}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("候補レビュー件数が不正です");
  const createdAt = new Date().toISOString();
  return {
    schema_version: CANDIDATE_REVIEW_SCHEMA_VERSION,
    date,
    status: "pending",
    created_at: createdAt,
    completed_at: "",
    candidates: candidates.slice(0, limit).map((candidate, position) => toReviewItem(candidate, position + 1))
  };
}

export async function writeCandidateReviewState(filePath: string, state: CandidateReviewState) {
  validateCandidateReviewState(state, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readCandidateReviewState(filePath: string): Promise<CandidateReviewState> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as CandidateReviewState;
  validateCandidateReviewState(parsed, filePath);
  return parsed;
}

/** Stores only actually rated candidates. An omitted candidate is never a negative example. */
export function applyCandidateRatings(state: CandidateReviewState, decisions: CandidateRatingDecision[], operator: SelectionFeedbackRecord["operator"] = "local_candidate_ui") {
  if (state.status === "completed") throw new Error(`${state.date} の候補レビューはすでに完了しています`);
  const normalized = validateRatingDecisions(decisions, state.candidates.length);
  const byIndex = new Map(normalized.map((decision) => [decision.index, decision]));
  const completedAt = new Date().toISOString();
  const candidates = state.candidates.map((candidate) => {
    const decision = byIndex.get(candidate.index);
    if (!decision) return candidate;
    return {
      ...candidate,
      human_rating: decision.rating,
      human_reason_tags: decision.reasonTags,
      human_note: decision.note,
      similar_topics: decision.similarTopics
    };
  });
  const nextState: CandidateReviewState = { ...state, status: "completed", completed_at: completedAt, candidates };
  const feedback = candidates
    .filter((candidate): candidate is CandidateReviewItem & { human_rating: CandidateInterestRating } => candidate.human_rating !== null)
    .map((candidate) => buildFeedbackRecord(nextState.date, candidate, completedAt, operator));
  return { state: nextState, feedback };
}

export async function appendSelectionFeedback(filePath: string, records: SelectionFeedbackRecord[]) {
  if (!records.length) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/**
 * The generator reads only the compact, structured learning fields.  Free-text
 * notes and similar-topic requests remain in the local review record and are
 * never made available to a model prompt or a selection gate.
 */
export async function readSelectionFeedback(filePath: string): Promise<SelectionFeedback[]> {
  let contents = "";
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  const feedback: SelectionFeedback[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<SelectionFeedbackRecord>;
      if (
        value.schema_version !== SELECTION_FEEDBACK_SCHEMA_VERSION ||
        typeof value.topic_key !== "string" ||
        typeof value.date !== "string" ||
        ![1, 2, 3, 4, 5].includes(value.human_rating as number) ||
        !Array.isArray(value.interest_features)
      ) continue;
      feedback.push({
        topic_key: value.topic_key,
        run_date: value.date,
        human_rating: value.human_rating as SelectionFeedback["human_rating"],
        interest_features: value.interest_features.filter((feature): feature is SelectionFeedback["interest_features"][number] =>
          typeof feature === "string" && (INTEREST_FEATURE_IDS as readonly string[]).includes(feature)
        )
      });
    } catch {
      // One malformed historical line must not block daily generation.
    }
  }
  return feedback;
}

export function candidateReviewPath(dataDir: string, date: string) {
  return path.join(dataDir, date, "candidate_review.json");
}

export function selectionFeedbackPath(dataDir: string) {
  return path.join(dataDir, "selection-feedback.jsonl");
}

/** Writes the generated candidate-review snapshot alongside other daily output. */
export async function writeCandidateReviewSnapshot(state: CandidateReviewState, date = state.date) {
  const outputDir = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output");
  const filePath = path.join(outputDir, `candidate_review_${date}.json`);
  await writeCandidateReviewState(filePath, state);
  return filePath;
}

export async function createCandidateReviewFromTopicFile(topicFilePath: string, reviewFilePath: string, date: string, limit = 12) {
  const parsed = JSON.parse(await fs.readFile(topicFilePath, "utf8")) as { topic_candidates?: TopicCandidate[] };
  if (!Array.isArray(parsed.topic_candidates)) throw new Error(`topic_candidates が不正です: ${topicFilePath}`);
  const state = createCandidateReviewState(parsed.topic_candidates, date, limit);
  await writeCandidateReviewState(reviewFilePath, state);
  return state;
}

function toReviewItem(candidate: CandidateReviewInput, index: number): CandidateReviewItem {
  const sourceNames = [...new Set(candidate.evidence_articles.map((source) => source.source_name).filter(Boolean))].slice(0, 8);
  return {
    index,
    topic_key: candidate.topic_key,
    title: candidate.title_hint,
    event_sentence: candidate.event_sentence,
    topic_type: candidate.topic_type,
    baseline_rank: index,
    baseline_priority: candidate.publish_priority,
    baseline_score: candidate.newsworthiness_score,
    source_count: candidate.source_count,
    source_types: candidate.source_mix,
    source_names: sourceNames,
    risk_class: inferRiskClass(candidate),
    caution_note: candidate.caution_note,
    interest_features: classifyInterestFeatures({
      topic_key: candidate.topic_key,
      title: candidate.title_hint,
      event_sentence: candidate.event_sentence,
      search_queries: [],
      entities: [...candidate.main_entities.people, ...candidate.main_entities.works, ...candidate.main_entities.organizations, ...candidate.main_entities.events],
      evidence_text: candidate.evidence_articles.flatMap((article) => [article.title, ...article.key_points]),
      baseline_rank: index
    }).map((match) => match.id),
    human_rating: null,
    human_reason_tags: [],
    human_note: "",
    similar_topics: []
  };
}

function inferRiskClass(candidate: CandidateReviewInput): CandidateRiskClass {
  const text = `${candidate.title_hint} ${candidate.event_sentence} ${candidate.topic_key}`;
  if (candidate.topic_type === "gossip_rumor" || /逝世|去世|讣告|离婚|婚姻|共同抚养|子女|病情|恋情/.test(text)) return "high";
  if (candidate.topic_type === "fan_culture" || /延期|撤档|取消|表情包|热搜|回应/.test(text)) return "medium";
  return "low";
}

function validateCandidateReviewState(state: CandidateReviewState, filePath: string) {
  if (!state || state.schema_version !== CANDIDATE_REVIEW_SCHEMA_VERSION || !DATE_PATTERN.test(state.date) || !Array.isArray(state.candidates)) {
    throw new Error(`候補レビュー形式が不正です: ${filePath}`);
  }
}

function validateRatingDecisions(decisions: CandidateRatingDecision[], candidateCount: number) {
  if (!Array.isArray(decisions) || !decisions.length) throw new Error("候補評価がありません。未評価は送信せず、評価した候補だけ送信してください。");
  const indexes = new Set<number>();
  return decisions.map((decision) => {
    if (!Number.isInteger(decision.index) || decision.index < 1 || decision.index > candidateCount || indexes.has(decision.index)) {
      throw new Error("候補番号が不正です");
    }
    indexes.add(decision.index);
    if (![1, 2, 3, 4, 5].includes(decision.rating)) throw new Error(`${decision.index}番の関心度は1〜5で指定してください`);
    const reasonTags = [...new Set((decision.reasonTags ?? []).filter((tag): tag is CandidateReasonTag => candidateReasonTags.includes(tag as CandidateReasonTag)))];
    if (reasonTags.length !== (decision.reasonTags ?? []).length) throw new Error(`${decision.index}番の理由タグが不正です`);
    return {
      index: decision.index,
      rating: decision.rating as CandidateInterestRating,
      reasonTags,
      note: (decision.note ?? "").trim().slice(0, 1000),
      similarTopics: [...new Set((decision.similarTopics ?? []).map((topic) => topic.trim()).filter(Boolean))].slice(0, 12)
    };
  });
}

function buildFeedbackRecord(date: string, candidate: CandidateReviewItem & { human_rating: CandidateInterestRating }, createdAt: string, operator: SelectionFeedbackRecord["operator"]): SelectionFeedbackRecord {
  return {
    schema_version: SELECTION_FEEDBACK_SCHEMA_VERSION,
    event_id: `${date}:${candidate.topic_key}:${createdAt}`,
    date,
    stage: "candidate",
    topic_key: candidate.topic_key,
    human_rating: candidate.human_rating,
    human_reason_tags: candidate.human_reason_tags,
    human_note: candidate.human_note,
    similar_topics: candidate.similar_topics,
    interest_features: candidate.interest_features,
    risk_class: candidate.risk_class,
    evidence_snapshot: {
      source_count: candidate.source_count,
      source_types: candidate.source_types,
      source_names: candidate.source_names,
      caution_note: candidate.caution_note
    },
    baseline: {
      rank: candidate.baseline_rank,
      priority: candidate.baseline_priority,
      score: candidate.baseline_score
    },
    operator,
    created_at: createdAt
  };
}
