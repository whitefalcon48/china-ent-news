import type { PublishPriority, SourceTypeLabel, TopicCandidate, TopicType } from "../types.js";

/**
 * Human interest is deliberately separate from factual readiness and publication.
 * These types may be used to order additional research only.
 */
export const INTEREST_FEATURE_IDS = [
  "people_milestone_and_direct_words",
  "feminist_film_and_formal_screening",
  "release_schedule_change",
  "international_cultural_circulation",
  "audiovisual_ai_technology",
  "fan_culture_online_expression",
  "private_life_careful"
] as const;

export type InterestFeatureId = (typeof INTEREST_FEATURE_IDS)[number];
export type PreferenceRankingMode = "off" | "shadow" | "manual_weights";

export type InterestFeatureMatch = {
  id: InterestFeatureId;
  reasons: string[];
};

export type PreferenceCandidate = {
  topic_key: string;
  title: string;
  event_sentence?: string;
  search_queries?: string[];
  entities?: string[];
  evidence_text?: string[];
  /** Existing order after all eligibility, EVS, claim, and safety gates. */
  baseline_rank: number;
};

/** A submitted rating only. Missing ratings are never represented as a negative. */
export type SelectionFeedback = {
  topic_key: string;
  run_date: string;
  human_rating: 1 | 2 | 3 | 4 | 5;
  interest_features: InterestFeatureId[];
};

export type FeatureLearningStats = {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  ready: boolean;
};

export type PreferenceLearningReadiness = {
  feedback_count: number;
  run_count: number;
  shadow_ready: boolean;
  ranking_ready: boolean;
  features: Record<InterestFeatureId, FeatureLearningStats>;
};

export type PreferenceTraceItem = {
  topic_key: string;
  baseline_rank: number;
  research_rank: number;
  preference_boost: number;
  matched_features: InterestFeatureMatch[];
  reasons: string[];
};

export type PreferenceResearchOrder = {
  mode: PreferenceRankingMode;
  /** Preference never authorizes inclusion, generation, or publication. */
  affects: "research_order_only";
  ranking_applied: boolean;
  readiness: PreferenceLearningReadiness;
  candidates: PreferenceTraceItem[];
};

// Candidate-review contracts live here too so the review UI and preference
// analyzer share one append-only feedback shape without coupling either one to
// publication decisions.

export const CANDIDATE_REVIEW_SCHEMA_VERSION = 1;
export const SELECTION_FEEDBACK_SCHEMA_VERSION = 1;

export const candidateReasonTags = [
  "読みたい",
  "中国ローカル文脈",
  "作品・映画",
  "人物・発言",
  "業界・技術",
  "国際文化交流",
  "根拠を追加したい",
  "優先度低い",
  "興味範囲外"
] as const;

export type CandidateReasonTag = (typeof candidateReasonTags)[number];
export type CandidateInterestRating = 1 | 2 | 3 | 4 | 5;
export type CandidateRiskClass = "low" | "medium" | "high";

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
  | "caution_note"
  | "main_entities"
>;

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
  source_types: Record<SourceTypeLabel, number>;
  source_names: string[];
  risk_class: CandidateRiskClass;
  caution_note: string;
  interest_features: string[];
  human_rating: CandidateInterestRating | null;
  human_reason_tags: CandidateReasonTag[];
  human_note: string;
  similar_topics: string[];
};

export type CandidateReviewState = {
  schema_version: typeof CANDIDATE_REVIEW_SCHEMA_VERSION;
  date: string;
  status: "pending" | "completed";
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
  interest_features: string[];
  risk_class: CandidateRiskClass;
  evidence_snapshot: {
    source_count: number;
    source_types: Record<SourceTypeLabel, number>;
    source_names: string[];
    caution_note: string;
  };
  baseline: { rank: number; priority: PublishPriority; score: number };
  operator: "local_candidate_ui" | "github_issue" | "import";
  created_at: string;
};
