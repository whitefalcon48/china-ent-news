import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSelectionFeedback, applyCandidateRatings, createCandidateReviewState, readCandidateReviewState, readSelectionFeedback, writeCandidateReviewState } from "./preference/candidateReviewState.js";
import type { CandidateReviewInput } from "./preference/candidateReviewTypes.js";

const candidates: CandidateReviewInput[] = [
  {
    topic_key: "非穷尽列举",
    title_hint: "『非穷尽列举（インターエイリア）』が中国で正式上映",
    event_sentence: "这部具有女性主义讨论的电影在中国正式上映。",
    topic_type: "release",
    publish_priority: "medium",
    newsworthiness_score: 68,
    source_count: 1,
    source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [{ title: "正式上映", url: "https://example.test/inter-alia", source_name: "映画媒体", source_type: "media_report", published_date: "2026-08-02", freshness_label: "today", article_type: "news_event", reliability: "B", key_points: ["正式上映"] }],
    main_entities: { people: [], works: ["非穷尽列举"], organizations: [], events: [] },
    caution_note: "Single-source topic; keep wording cautious until another source appears."
  },
  {
    topic_key: "未評価候補",
    title_hint: "未評価候補",
    event_sentence: "評価しない候補。",
    topic_type: "unknown",
    publish_priority: "low",
    newsworthiness_score: 30,
    source_count: 1,
    source_mix: { official: 1, media_report: 0, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [{ title: "候補", url: "https://example.test/other", source_name: "公式", source_type: "official", published_date: "2026-08-02", freshness_label: "today", article_type: "official_announcement", reliability: "A", key_points: [] }],
    main_entities: { people: [], works: [], organizations: [], events: [] },
    caution_note: ""
  }
];

const state = createCandidateReviewState(candidates, "2026-08-02");
assert.equal(state.schema_version, 1);
assert.equal(state.candidates.length, 2);
assert.deepEqual(state.candidates[0].interest_features, ["feminist_film_and_formal_screening"]);
const applied = applyCandidateRatings(state, [{ index: 1, rating: 5, reasonTags: ["作品・映画", "フェミニズム・批評"], note: "正式上映の条件を確認したい", similarTopics: ["女性監督映画", "女性監督映画"] }]);
assert.equal(applied.state.status, "completed");
assert.equal(applied.state.candidates[1].human_rating, null, "未評価候補を負例にしてはいけない");
assert.equal(applied.feedback.length, 1, "評価済み候補だけを履歴に残す");
assert.equal(applied.feedback[0].human_rating, 5);
assert.deepEqual(applied.feedback[0].similar_topics, ["女性監督映画"]);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-preference-test-"));
try {
  const reviewPath = path.join(directory, "candidate_review.json");
  const feedbackPath = path.join(directory, "selection-feedback.jsonl");
  await writeCandidateReviewState(reviewPath, applied.state);
  assert.equal((await readCandidateReviewState(reviewPath)).candidates[0].human_note, "正式上映の条件を確認したい");
  await appendSelectionFeedback(feedbackPath, applied.feedback);
  await fs.appendFile(feedbackPath, "{not-json}\n", "utf8");
  const records = (await fs.readFile(feedbackPath, "utf8")).trim().split("\n").filter((line) => line.startsWith('{"')).map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].schema_version, 1);
  const learning = await readSelectionFeedback(feedbackPath);
  assert.deepEqual(learning, [{
    topic_key: applied.feedback[0]?.topic_key,
    run_date: "2026-08-02",
    human_rating: 5,
    interest_features: ["feminist_film_and_formal_screening"]
  }], "only valid structured ratings are used for learning; free-text is not returned");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log("candidate preference tests passed.");
