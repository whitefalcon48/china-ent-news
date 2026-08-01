import assert from "node:assert/strict";
import fs from "node:fs";
import { selectEditorialReviewRescue, type EditorialValueAssessment } from "./editorialValue.js";

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

assert.deepEqual(
  selectEditorialReviewRescue([assessment("six", 6)], { enabled: false }).selected_topic_keys,
  [],
  "レビューゲート無効時は救済しない"
);

assert.equal(
  selectEditorialReviewRescue([assessment("seven", 7), assessment("six", 6)], { enabled: true }).reason,
  "standard_qualified",
  "通常合格が1件でもあれば救済しない"
);

assert.deepEqual(
  selectEditorialReviewRescue(
    [assessment("c", 6), assessment("a", 6), assessment("b", 6), assessment("five", 5)],
    { enabled: true, limit: 2 }
  ).selected_topic_keys,
  ["a", "b"],
  "6点候補だけを決定的な順序で上限まで救済する"
);

assert.equal(
  selectEditorialReviewRescue([assessment("five", 5)], { enabled: true }).reason,
  "no_borderline_candidates",
  "6点未満は救済しない"
);

const savedTracePath = "data/2026-07-27/selection_trace_2026-07-27.json";
if (fs.existsSync(savedTracePath)) {
  const savedTrace = JSON.parse(fs.readFileSync(savedTracePath, "utf8")) as {
    editorial_value: { candidates: EditorialValueAssessment[] };
  };
  const replay = selectEditorialReviewRescue(savedTrace.editorial_value.candidates, { enabled: true });
  assert.equal(replay.activated, true, "0件だった7月27日の実traceでは救済が発動する");
  assert.ok(replay.selected_topic_keys.length >= 1 && replay.selected_topic_keys.length <= 3, "実traceの救済件数は1〜3件");
  assert.ok(
    replay.selected_topic_keys.every((topicKey) => savedTrace.editorial_value.candidates.find((item) => item.topic_key === topicKey)?.total === 6),
    "実traceでは6点候補だけを救済する"
  );
}

console.log("EVS review rescue tests passed.");
