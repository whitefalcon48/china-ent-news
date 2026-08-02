import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { EditorialValueAssessment } from "./editorialValue.js";
import { buildReviewIssueBody } from "./review/buildReviewIssueBody.js";
import { parseReviewComment } from "./review/parseReviewComment.js";
import { selectStoredReviewRescue } from "./review/rescueEmptyReview.js";
import type { TopicCandidate } from "./types.js";

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

console.log("review rescue tests passed.");
