import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectEditorialReviewRescue } from "./editorialValue.js";
import { evaluateTopicHistory, loadPublicationHistory, type PublicationHistory, type PublicationHistoryEntry } from "./publicationHistory.js";
import type { TopicCandidate } from "./types.js";

function historyEntry(overrides: Partial<PublicationHistoryEntry> = {}): PublicationHistoryEntry {
  return {
    date: "2026-08-16",
    topic_key: "欢迎来龙餐馆",
    title: "《欢迎来龙餐馆》票房破3亿元，豆瓣8.4",
    status: "rejected",
    reason_tag: "その他",
    entities: { people: ["沈腾"], works: ["欢迎来龙餐馆"], organizations: [] },
    topic_type: "box_office",
    evidence_urls: ["https://example.com/old"],
    evidence_texts: ["《欢迎来龙餐馆》票房破3亿元，豆瓣8.4"],
    ...overrides
  };
}

function candidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    topic_key: "欢迎来龙餐馆",
    title_hint: "《欢迎来龙餐馆》票房破3亿元，豆瓣8.4",
    event_sentence: "《欢迎来龙餐馆》票房破3亿元。",
    search_queries: [],
    seed_source: "fallback",
    seed_confidence: 0.9,
    topic_type: "box_office",
    freshness_label: "recent",
    published_date_range: { earliest: "2026-08-12", latest: "2026-08-12" },
    source_count: 1,
    source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [{
      title: "《欢迎来龙餐馆》票房破3亿元，豆瓣8.4",
      url: "https://example.com/repost",
      source_name: "fixture",
      source_type: "media_report",
      published_date: "2026-08-12",
      freshness_label: "recent",
      article_type: "data_report",
      reliability: "B",
      key_points: ["票房突破3亿元", "豆瓣评分8.4"],
      media_family: "example.com"
    }],
    main_entities: { people: ["沈腾"], works: ["欢迎来龙餐馆"], organizations: [], events: [] },
    signals: { has_multiple_sources: false, has_official_source: false, has_media_context: true, has_hot_search_signal: false, has_data_signal: false },
    newsworthiness_score: 80,
    japan_gap: "high",
    context_value: "high",
    publish_priority: "high",
    selection_reason: "fixture",
    caution_note: "",
    related_evidence_articles: [],
    ...overrides
  } as TopicCandidate;
}

const history: PublicationHistory = { loaded_days: ["2026-08-16"], entries: [historyEntry()] };
const oldRepost = evaluateTopicHistory(candidate(), history);
assert.equal(oldRepost?.decision, "dup_no_update", "review日以前の記事を別URLで再掲しても続報にしない");
assert.equal(oldRepost?.decision_reason, "history_cooldown:no_newer_evidence");

const sameMilestone = evaluateTopicHistory(candidate({
  evidence_articles: [{ ...candidate().evidence_articles[0]!, published_date: "2026-08-17", url: "https://example.com/new-repost" }],
  published_date_range: { earliest: "2026-08-17", latest: "2026-08-17" }
}), history);
assert.equal(sameMilestone?.decision, "dup_no_update", "翌日の別URLでも同じ3億元なら続報にしない");
assert.equal(sameMilestone?.decision_reason, "history_cooldown:no_novel_update");

const newMilestone = evaluateTopicHistory(candidate({
  title_hint: "《欢迎来龙餐馆》票房破7亿元",
  event_sentence: "《欢迎来龙餐馆》票房破7亿元。",
  evidence_articles: [{
    ...candidate().evidence_articles[0]!,
    title: "《欢迎来龙餐馆》票房突破7亿元",
    key_points: ["票房突破7亿元"],
    published_date: "2026-08-17",
    url: "https://example.com/seven"
  }],
  published_date_range: { earliest: "2026-08-17", latest: "2026-08-17" }
}), history);
assert.equal(newMilestone?.decision, "reselect_allowed", "新しい数値到達は明確な続報として再採用できる");
assert.equal(newMilestone?.decision_reason, "history_follow_up:result");

const renamedEvent = evaluateTopicHistory(candidate({
  topic_key: "龙餐馆偷票房争议",
  title_hint: "《龙餐馆》回应偷票房争议",
  event_sentence: "《龙餐馆》回应偷票房争议。",
  main_entities: { people: [], works: ["欢迎来龙餐馆", "龙餐馆"], organizations: [], events: ["偷票房争议"] },
  evidence_articles: [{
    ...candidate().evidence_articles[0]!,
    title: "《龙餐馆》回应偷票房争议",
    key_points: ["影院操作失误"],
    published_date: "2026-08-14",
    url: "https://example.com/dispute"
  }]
}), {
  loaded_days: ["2026-08-16"],
  entries: [historyEntry({
    topic_key: "龙餐馆",
    title: "『龍餐館』は映画館の操作ミスと説明",
    entities: { people: [], works: ["龙餐馆"], organizations: [] },
    evidence_texts: ["《龙餐馆》回应偷票房争议，系影院操作失误"]
  })]
});
assert.equal(renamedEvent?.decision_reason, "history_cooldown:no_newer_evidence", "別topic_keyでも同一作品・出来事を休ませる");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publication-history-"));
try {
  for (const date of ["2026-08-17", "2026-08-04", "2026-08-03"]) {
    const directory = path.join(tempRoot, date);
    await fs.mkdir(directory, { recursive: true });
    const topicKey = `topic-${date}`;
    await fs.writeFile(path.join(directory, "review.json"), JSON.stringify({
      date,
      status: "completed",
      issue_number: 1,
      articles: [{ index: 1, topic_key: topicKey, title: topicKey, status: "rejected", reason_tag: "その他", comment: "fixture", revision_count: 0 }]
    }), "utf8");
    await fs.writeFile(path.join(directory, `articles_${date}.json`), JSON.stringify([{
      raw: { title: topicKey, url: `https://example.com/${date}` },
      topic: {
        topic_key: topicKey,
        topic_type: "unknown",
        main_entities: { people: [], works: [topicKey], organizations: [], events: [] },
        evidence_articles: []
      }
    }]), "utf8");
  }
  const loaded = await loadPublicationHistory("2026-08-17", 14, tempRoot);
  assert.ok(loaded.loaded_days.includes("2026-08-17"), "同日再生成用に当日reviewを履歴へ含める");
  assert.ok(loaded.loaded_days.includes("2026-08-04"), "当日込み14日間の末日を含める");
  assert.ok(!loaded.loaded_days.includes("2026-08-03"), "14日より前はcooldown対象にしない");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const savedCandidatesPath = "data/2026-08-17/topic_candidates_2026-08-17.json";
const savedTracePath = "data/2026-08-17/selection_trace_2026-08-17.json";
try {
  const savedCandidates = JSON.parse(await fs.readFile(savedCandidatesPath, "utf8")) as { topic_candidates: TopicCandidate[] };
  const savedTrace = JSON.parse(await fs.readFile(savedTracePath, "utf8")) as {
    editorial_value: { candidates: Parameters<typeof selectEditorialReviewRescue>[0] };
  };
  const fullHistory = await loadPublicationHistory("2026-08-17");
  const beforeCurrentDay = {
    loaded_days: fullHistory.loaded_days.filter((date) => date < "2026-08-17"),
    entries: fullHistory.entries.filter((entry) => entry.date < "2026-08-17")
  };
  const repeatedTopicKeys = ["龙餐馆偷票房争议", "欢迎来龙餐馆"];
  const comparison = repeatedTopicKeys.map((topicKey) => {
    const topic = savedCandidates.topic_candidates.find((item) => item.topic_key === topicKey);
    assert.ok(topic, `${topicKey} fixture exists`);
    const firstRunDecision = evaluateTopicHistory(topic, beforeCurrentDay);
    const rerunDecision = evaluateTopicHistory(topic, fullHistory);
    assert.equal(firstRunDecision?.decision_reason, "history_cooldown:no_newer_evidence", `${topicKey} is blocked against prior days`);
    assert.equal(rerunDecision?.decision_reason, "history_cooldown:no_newer_evidence", `${topicKey} is blocked on a same-day rerun`);
    return { topic_key: topicKey, first_run: firstRunDecision?.decision_reason, same_day_rerun: rerunDecision?.decision_reason };
  });
  const remainingAssessments = savedTrace.editorial_value.candidates.filter((item) => !repeatedTopicKeys.includes(item.topic_key));
  const rescue = selectEditorialReviewRescue(remainingAssessments, { enabled: true });
  assert.deepEqual(rescue.selected_topic_keys, ["影之刃零", "短剧网文IP供给"], "重複映画を除くと異なるtopicの既存EVS-6救済候補が残る");
  console.log(JSON.stringify({
    saved_2026_08_17_history: { loaded_days: fullHistory.loaded_days, entry_count: fullHistory.entries.length },
    saved_2026_08_17_comparison: comparison,
    rescue_after_cooldown: rescue.selected_topic_keys
  }));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

console.log("publication history cooldown tests passed.");
