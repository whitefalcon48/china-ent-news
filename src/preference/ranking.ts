import { classifyInterestFeatures } from "./interestTags.js";
import { INTEREST_FEATURE_IDS, type FeatureLearningStats, type InterestFeatureId, type PreferenceCandidate, type PreferenceLearningReadiness, type PreferenceRankingMode, type PreferenceResearchOrder, type SelectionFeedback } from "./types.js";

export const DEFAULT_PREFERENCE_RANKING_MODE: PreferenceRankingMode = "shadow";
const MIN_SHADOW_FEEDBACK = 40;
const MIN_SHADOW_RUNS = 8;
const MIN_RANKING_FEEDBACK = 100;
const MIN_FEATURE_FEEDBACK = 12;
const MIN_FEATURE_POSITIVE = 3;
const MIN_FEATURE_NEGATIVE = 3;

export function getPreferenceRankingMode(value = process.env.PREFERENCE_RANKING_MODE): PreferenceRankingMode {
  if (value === "off" || value === "shadow" || value === "manual_weights") return value;
  return DEFAULT_PREFERENCE_RANKING_MODE;
}

export function summarizePreferenceLearning(feedback: SelectionFeedback[]): PreferenceLearningReadiness {
  const features = Object.fromEntries(
    INTEREST_FEATURE_IDS.map((id) => [id, { total: 0, positive: 0, negative: 0, neutral: 0, ready: false } satisfies FeatureLearningStats])
  ) as Record<InterestFeatureId, FeatureLearningStats>;

  for (const item of feedback) {
    for (const feature of new Set(item.interest_features)) {
      const stat = features[feature];
      if (!stat) continue;
      stat.total += 1;
      if (item.human_rating >= 4) stat.positive += 1;
      else if (item.human_rating <= 2) stat.negative += 1;
      else stat.neutral += 1;
    }
  }
  for (const stat of Object.values(features)) {
    stat.ready = stat.total >= MIN_FEATURE_FEEDBACK && stat.positive >= MIN_FEATURE_POSITIVE && stat.negative >= MIN_FEATURE_NEGATIVE;
  }

  const runCount = new Set(feedback.map((item) => item.run_date).filter(Boolean)).size;
  return {
    feedback_count: feedback.length,
    run_count: runCount,
    shadow_ready: feedback.length >= MIN_SHADOW_FEEDBACK && runCount >= MIN_SHADOW_RUNS,
    ranking_ready: feedback.length >= MIN_RANKING_FEEDBACK && Object.values(features).some((stat) => stat.ready),
    features
  };
}

/**
 * Produces an order for source expansion/research queues only. The caller must
 * run existing fact, claim, EVS, safety, and publication gates unchanged.
 */
export function buildPreferenceResearchOrder(args: {
  candidates: PreferenceCandidate[];
  feedback: SelectionFeedback[];
  mode?: PreferenceRankingMode;
  manual_weights?: Partial<Record<InterestFeatureId, number>>;
}): PreferenceResearchOrder {
  const mode = args.mode ?? getPreferenceRankingMode();
  const readiness = summarizePreferenceLearning(args.feedback);
  const canApply = mode === "manual_weights" && readiness.ranking_ready && Boolean(args.manual_weights);
  const staged = args.candidates.map((candidate) => {
    const matchedFeatures = classifyInterestFeatures(candidate);
    const eligibleFeatures = matchedFeatures.filter((match) => readiness.features[match.id].ready);
    const rawBoost = eligibleFeatures.reduce((sum, match) => sum + clampWeight(args.manual_weights?.[match.id]), 0);
    const preferenceBoost = canApply ? rawBoost : 0;
    const reasons = [
      `baseline_rank:${candidate.baseline_rank}`,
      ...matchedFeatures.map((match) => `interest_feature:${match.id}:${match.reasons.join(",")}`),
      mode === "off" ? "preference_mode_off" : "preference_research_only",
      !canApply && mode === "manual_weights" ? "manual_weights_not_ready" : "",
      mode === "shadow" ? "shadow_no_reorder" : ""
    ].filter(Boolean);
    return { candidate, matchedFeatures, preferenceBoost, reasons };
  });

  const ordered = canApply
    ? [...staged].sort((left, right) => right.preferenceBoost - left.preferenceBoost || left.candidate.baseline_rank - right.candidate.baseline_rank || left.candidate.topic_key.localeCompare(right.candidate.topic_key, "ja"))
    : [...staged].sort((left, right) => left.candidate.baseline_rank - right.candidate.baseline_rank || left.candidate.topic_key.localeCompare(right.candidate.topic_key, "ja"));

  return {
    mode,
    affects: "research_order_only",
    ranking_applied: canApply,
    readiness,
    candidates: ordered.map((item, index) => ({
      topic_key: item.candidate.topic_key,
      baseline_rank: item.candidate.baseline_rank,
      research_rank: index + 1,
      preference_boost: item.preferenceBoost,
      matched_features: item.matchedFeatures,
      reasons: item.reasons
    }))
  };
}

function clampWeight(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-20, Math.min(20, Math.round(value as number)));
}
