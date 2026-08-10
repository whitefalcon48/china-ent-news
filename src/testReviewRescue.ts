import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { EditorialValueAssessment } from "./editorialValue.js";
import { buildReviewIssueBody } from "./review/buildReviewIssueBody.js";
import { parseReviewComment } from "./review/parseReviewComment.js";
import { getCurrentReviewTopicKeys, selectStoredReviewRescue } from "./review/rescueEmptyReview.js";
import type { ProcessedArticle, TopicCandidate } from "./types.js";

function assessment(topicKey: string, total: number): EditorialValueAssessment {
  const axis = { score: 0, reason: "test" };
  return {
    topic_key: topicKey,
    axes: {
      freshness_update: axis,
      corroboration: axis,
      local_heat: axis,
      japan_value: axis,
      bingtang_angle: { ...axis, angle_hint: "" }
    },
    total,
    caps: [],
    result: total >= 7 ? "qualified" : "evs_below_threshold"
  };
}

const parsed = parseReviewComment("救済再生成");
assert.deepEqual(parsed.invalidLines, [], "救済再生成は既存の判定文法と並行して受理する");
assert.equal(parsed.decisions[0]?.action, "rescue_rebuild", "救済再生成を専用アクションにする");
assert.match(
  buildReviewIssueBody({ date: "2026-07-25", status: "pending", issue_number: 9, articles: [] }, []),
  /救済再生成/,
  "0件Issueは救済再生成の案内を表示する"
);

const dates = ["2026-07-25", "2026-07-26", "2026-07-27", "2026-07-29", "2026-07-31"];
const selectedByDate = new Map<string, string[]>();
for (const date of dates) {
  const directory = path.join("data", date);
  const trace = JSON.parse(fs.readFileSync(path.join(directory, `selection_trace_${date}.json`), "utf8")) as {
    editorial_value: { candidates: EditorialValueAssessment[] };
  };
  const candidates = JSON.parse(fs.readFileSync(path.join(directory, `topic_candidates_${date}.json`), "utf8")) as { topic_candidates: TopicCandidate[] };
  const selection = selectStoredReviewRescue(trace, candidates.topic_candidates);
  assert.ok(selection.rescue.activated, `${date} has saved EVS-6 rescue candidates`);
  assert.ok(selection.topics.length >= 1 && selection.topics.length <= 3, `${date} selects 1-3 saved topics`);
  assert.ok(
    selection.topics.every((topic) => trace.editorial_value.candidates.find((assessment) => assessment.topic_key === topic.topic_key)?.total === 6),
    `${date} selects only EVS-6 topics`
  );
  selectedByDate.set(date, selection.topics.map((topic) => topic.topic_key));
}

const july25 = selectedByDate.get("2026-07-25") ?? [];
const july26 = selectedByDate.get("2026-07-26") ?? [];
const afterJuly25 = selectStoredReviewRescue(
  JSON.parse(fs.readFileSync("data/2026-07-26/selection_trace_2026-07-26.json", "utf8")),
  JSON.parse(fs.readFileSync("data/2026-07-26/topic_candidates_2026-07-26.json", "utf8")).topic_candidates,
  new Set(july25)
);
assert.deepEqual(afterJuly25.topics.map((topic) => topic.topic_key), [], "前日の救済topicは翌日の救済候補から除外する");
assert.deepEqual(july25, july26, "7月25日と26日の保存候補は同一topicであることを確認する");

const failedQualified = selectStoredReviewRescue(
  {
    generation_status: { status: "generation_failed", failed_topic_keys: ["seven"] },
    editorial_value: {
      candidates: [
        { ...assessment("seven", 7), result: "qualified" },
        assessment("six", 6)
      ]
    }
  },
  [{ topic_key: "seven" }, { topic_key: "six" }] as TopicCandidate[]
);
assert.deepEqual(
  failedQualified.topics.map((topic) => topic.topic_key),
  ["six"],
  "EVS 7 failed generation allows the next EVS 6 rescue candidate"
);

const existingReviewKeys = getCurrentReviewTopicKeys([
  { raw: {} as ProcessedArticle["raw"], topic: { topic_key: "published" } as TopicCandidate }
]);
const partialRescue = selectStoredReviewRescue(
  {
    generation_status: { status: "succeeded", failed_topic_keys: ["failed"] },
    editorial_value: { candidates: [assessment("published", 7), assessment("failed", 6), assessment("remaining", 6)] }
  },
  [{ topic_key: "published" }, { topic_key: "failed" }, { topic_key: "remaining" }] as TopicCandidate[],
  existingReviewKeys
);
assert.deepEqual(partialRescue.topics.map((topic) => topic.topic_key), ["remaining"], "partial rescue appends only an ungenerated, never-failed topic");

console.log("review rescue tests passed.");
