import assert from "node:assert/strict";
import { buildPreferenceResearchOrder, classifyInterestFeatures, getPreferenceRankingMode, summarizePreferenceLearning, type InterestFeatureId, type PreferenceCandidate, type SelectionFeedback } from "./preference/index.js";

function candidate(topic_key: string, baseline_rank: number, title: string, event_sentence = ""): PreferenceCandidate {
  return { topic_key, baseline_rank, title, event_sentence };
}

function feedback(feature: InterestFeatureId, rating: 1 | 2 | 3 | 4 | 5, index: number): SelectionFeedback {
  return { topic_key: `topic-${index}`, run_date: `2026-07-${String((index % 8) + 1).padStart(2, "0")}`, human_rating: rating, interest_features: [feature] };
}

const interAlia = candidate(
  "inter-alia",
  2,
  "《非穷尽列举》（Inter Alia）中国正式上映",
  "这部在女性主义与电影讨论中受到关注的作品将在中国正式放映。"
);
assert.deepEqual(
  classifyInterestFeatures(interAlia).map((item) => item.id),
  ["feminist_film_and_formal_screening"],
  "Inter Alia is classified only through feminist/film/formal-screening context"
);
assert.ok(
  !classifyInterestFeatures(candidate("foreign-stage", 1, "海外舞台作品来华演出")).some((item) => item.id === "feminist_film_and_formal_screening"),
  "generic foreign stage works are outside this interest feature"
);

const sparseFeedback = [feedback("release_schedule_change", 5, 1)];
const shadowOrder = buildPreferenceResearchOrder({
  candidates: [candidate("plain", 1, "普通电影消息"), candidate("delay", 2, "影片宣布延期上映")],
  feedback: sparseFeedback,
  mode: "shadow",
  manual_weights: { release_schedule_change: 10 }
});
assert.equal(shadowOrder.ranking_applied, false, "shadow mode never changes research order");
assert.deepEqual(shadowOrder.candidates.map((item) => item.topic_key), ["plain", "delay"], "shadow keeps baseline order");
assert.equal(shadowOrder.candidates[1]?.preference_boost, 0, "not-ready feature produces no applied boost");
assert.equal(shadowOrder.affects, "research_order_only", "preference result is explicitly research-only");

const enoughFeedback: SelectionFeedback[] = [];
for (let index = 0; index < 100; index += 1) {
  enoughFeedback.push(feedback("release_schedule_change", index % 2 === 0 ? 5 : 1, index));
}
const readiness = summarizePreferenceLearning(enoughFeedback);
assert.equal(readiness.shadow_ready, true, "40 ratings across 8 runs enables observation reporting");
assert.equal(readiness.ranking_ready, true, "100 ratings and balanced feature evidence enables manually approved weights");

const manualOrder = buildPreferenceResearchOrder({
  candidates: [candidate("plain", 1, "普通电影消息"), candidate("delay", 2, "影片宣布延期上映")],
  feedback: enoughFeedback,
  mode: "manual_weights",
  manual_weights: { release_schedule_change: 10 }
});
assert.equal(manualOrder.ranking_applied, true, "manual weights apply only after all readiness conditions");
assert.deepEqual(manualOrder.candidates.map((item) => item.topic_key), ["delay", "plain"], "approved interest weight changes research order only");
assert.equal(manualOrder.candidates[0]?.baseline_rank, 2, "trace preserves the original rank");
assert.equal(manualOrder.candidates[0]?.preference_boost, 10, "trace exposes the applied boost");

assert.equal(getPreferenceRankingMode("invalid"), "shadow", "invalid mode falls back to safe shadow mode");
assert.equal(getPreferenceRankingMode("off"), "off", "off mode is available");
console.log("Preference ranking tests passed.");
