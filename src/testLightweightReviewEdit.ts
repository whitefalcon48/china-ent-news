import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyLightweightWhyItMattersEdit } from "./review/lightweightWhyItMattersEdit.js";
import { reviseStoredArticle, tryApplyLightweightWhyItMattersEdit } from "./review/reviseArticle.js";
import type { FactLedger, ProcessedArticle, SummarizedArticle, TopicCandidate } from "./types.js";

const ledger: FactLedger = {
  topic_key: "fixture-topic",
  claims: [],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
};

const topic = {
  topic_key: "fixture-topic",
  title_hint: "テスト",
  event_sentence: "テストです。",
  source_mix: {},
  evidence_articles: []
} as unknown as TopicCandidate;

function summary(whyItMatters = "まず背景を確認します。これ、見てほしいです！次の動きも追います！"): SummarizedArticle {
  return {
    title_ja: "記事タイトル",
    badge: "NEWS",
    lead: "リードです。",
    what_happened: "本文です。",
    why_it_matters: whyItMatters,
    reaction_view: "",
    editor_comment: "",
    japan_context_note: "",
    category: "話題",
    confidence: "B",
    source_type: "media_report",
    published_date: "2026-08-11",
    event_date: "2026-08-11",
    freshness_label: "today",
    newsworthiness_score: 8,
    japan_visibility: "low",
    japan_gap: "high",
    context_value: "medium",
    sns_heat: "none",
    source_count: 1,
    source_list: [],
    has_official_source: false,
    has_multiple_sources: false,
    has_sns_signal: false,
    article_type: "news_event",
    skip_reason: "",
    verification_status: "verified",
    topic_key: "fixture-topic",
    main_entities: { people: [], works: [], organizations: [] },
    related_sources: [],
    tags: [],
    publish_priority: "medium",
    publish_reason: "fixture",
    claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
  };
}

const deletionComment = "注目ポイントの　「これ、見てほしいです！」削除";
const deleted = applyLightweightWhyItMattersEdit(summary().why_it_matters, deletionComment);
assert.deepEqual(deleted, {
  ok: true,
  value: "まず背景を確認します。次の動きも追います！",
  edit: { literal: "これ、見てほしいです！" }
}, "句読点を含む一意の呼びかけを、接続を崩さず削除する");

assert.equal(
  applyLightweightWhyItMattersEdit("別の文です。", deletionComment).ok,
  false,
  "対象句が0件ならLLM再生成へフォールバックする"
);
assert.equal(
  applyLightweightWhyItMattersEdit("これ、見てほしいです！これ、見てほしいです！", deletionComment).ok,
  false,
  "対象句が複数ならLLM再生成へフォールバックする"
);

assert.equal(
  applyLightweightWhyItMattersEdit("この続報を見届けたいです！", "「見届けたい」を「追いかけたい」に変更してください。").ok,
  false,
  "置換指示は安全のため既存LLM再生成へフォールバックする"
);
assert.equal(
  applyLightweightWhyItMattersEdit("この注目点を追います。", "「注目」を「中国で大ヒット」に変更").ok,
  false,
  "監査再現の強い意味変更も決定的経路では扱わずLLMへフォールバックする"
);

assert.equal(
  applyLightweightWhyItMattersEdit(summary().why_it_matters, "「これ、見てほしいです！」を削除して、タイトルも変更してください。").ok,
  false,
  "他フィールドへの指示を含む文はLLM再生成へフォールバックする"
);

const original = summary();
const deterministic = tryApplyLightweightWhyItMattersEdit(original, topic, ledger, deletionComment);
assert.ok(deterministic, "有効な台帳・claim check下の一意な削除はAPIなしで成立する");
assert.equal(deterministic.summary.why_it_matters, "まず背景を確認します。次の動きも追います！");
const { why_it_matters: _beforeWhy, ...beforeOtherFields } = original;
const { why_it_matters: _afterWhy, ...afterOtherFields } = deterministic.summary;
assert.deepEqual(afterOtherFields, beforeOtherFields, "why_it_matters以外のsummaryフィールドとclaim_refsを変えない");
assert.equal(deterministic.residues.length, 0, "表示用漢字の残留を持ち込まない");

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-news-review-edit-"));
try {
  const stored: ProcessedArticle = {
    raw: {
      title: "fixture",
      url: "https://example.com/fixture",
      sourceName: "fixture",
      sourceUrl: "https://example.com/",
      category: "話題",
      reliability: "B"
    },
    topic,
    summary: original,
    generationMeta: { topic_key: topic.topic_key, ledger_used: true, ledger_fallback_reason: "" }
  };
  await fs.writeFile(path.join(directory, "articles_2026-08-11.json"), `${JSON.stringify([stored], null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(directory, "fact_ledger_2026-08-11.json"), JSON.stringify({ ledgers: [{ topic_key: topic.topic_key, ledger }] }), "utf8");
  const revised = await reviseStoredArticle(directory, 1, deletionComment, "口調");
  assert.equal(revised.summary?.why_it_matters, "まず背景を確認します。次の動きも追います！");
  assert.equal(revised.generationMeta?.comment_stage?.fallback_reason, "review_literal_edit", "LLMなしの軽微修正経路を記録する");
  const persisted = JSON.parse(await fs.readFile(path.join(directory, "articles_2026-08-11.json"), "utf8")) as ProcessedArticle[];
  assert.equal(persisted[0].summary?.why_it_matters, revised.summary?.why_it_matters, "決定的編集をarticles JSONに保存する");
  const { why_it_matters: _storedWhy, ...storedOtherFields } = persisted[0].summary!;
  assert.deepEqual(storedOtherFields, beforeOtherFields, "保存後も他summaryフィールドとclaim_refsを不変に保つ");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log("lightweight review edit tests passed.");
