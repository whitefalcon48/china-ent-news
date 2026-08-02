import type { PublishPriority, SourceTypeLabel, TopicCandidate, TopicType } from "../types.js";
import type { InterestFeatureId } from "./types.js";

export const CANDIDATE_REVIEW_SCHEMA_VERSION = 1 as const;
export const SELECTION_FEEDBACK_SCHEMA_VERSION = 1 as const;

export type CandidateInterestRating = 1 | 2 | 3 | 4 | 5;
export type CandidateReviewStatus = "pending" | "completed";
export type CandidateRiskClass = "low" | "medium" | "high";

export const candidateInterestLabels: Record<CandidateInterestRating, string> = {
  5: "ぜひ読みたい",
  4: "読みたい",
  3: "条件次第",
  2: "優先度低め",
  1: "興味なし"
};

export const candidateReasonTags = [
  "作品・映画",
  "人物・俳優",
  "現地での受容",
  "フェミニズム・批評",
  "業界・技術",
  "国際文化交流",
  "ネット文化",
  "追跡希望",
  "その他"
] as const;
export type CandidateReasonTag = (typeof candidateReasonTags)[number];

export type CandidateReviewItem = {
  index: number;
  topic_key: string;
  title: string;
  event_sentence: string;
  topic_type: TopicType;
  baseline_rank: number;
  baseline_priority: PublishPriority;
  baseline_score: number;
  source_count: number;
  source_types: Partial<Record<SourceTypeLabel, number>>;
  source_names: string[];
  risk_class: CandidateRiskClass;
  caution_note: string;
  interest_features: InterestFeatureId[];
  human_rating: CandidateInterestRating | null;
  human_reason_tags: CandidateReasonTag[];
  human_note: string;
  similar_topics: string[];
};

export type CandidateReviewState = {
  schema_version: typeof CANDIDATE_REVIEW_SCHEMA_VERSION;
  date: string;
  status: CandidateReviewStatus;
  created_at: string;
  completed_at: string;
  candidates: CandidateReviewItem[];
};

export type CandidateRatingDecision = {
  index: number;
  rating: CandidateInterestRating;
  reasonTags?: CandidateReasonTag[];
  note?: string;
  similarTopics?: string[];
};

export type SelectionFeedbackRecord = {
  schema_version: typeof SELECTION_FEEDBACK_SCHEMA_VERSION;
  event_id: string;
  date: string;
  stage: "candidate";
  topic_key: string;
  human_rating: CandidateInterestRating;
  human_reason_tags: CandidateReasonTag[];
  human_note: string;
  similar_topics: string[];
  interest_features: InterestFeatureId[];
  risk_class: CandidateRiskClass;
  evidence_snapshot: {
    source_count: number;
    source_types: Partial<Record<SourceTypeLabel, number>>;
    source_names: string[];
    caution_note: string;
  };
  baseline: { rank: number; priority: PublishPriority; score: number };
  operator: "local_candidate_ui" | "manual";
  created_at: string;
};

export type CandidateReviewInput = Pick<
  TopicCandidate,
  | "topic_key"
  | "title_hint"
  | "event_sentence"
  | "topic_type"
  | "publish_priority"
  | "newsworthiness_score"
  | "source_count"
  | "source_mix"
  | "evidence_articles"
  | "main_entities"
  | "caution_note"
>;
