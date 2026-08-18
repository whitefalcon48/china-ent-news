import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyLightweightWhyItMattersEdit } from "./review/lightweightWhyItMattersEdit.js";
import { reviseStoredArticle, tryApplyLightweightWhyItMattersEdit } from "./review/reviseArticle.js";
import { ReviewRevisionClarificationRequiredError } from "./review/revisionPatch.js";
import { formatToneOnlyReviewInstruction } from "./summarizeWithGemini.js";
import { assertToneOnlyRevisionContract, ToneOnlyRevisionContractError } from "./toneOnlyRevision.js";
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

const originalWithRefs = summary("まず背景を確認します。次の動きも追います！");
originalWithRefs.claim_refs.why_it_matters = ["C1"];
const toneOnly = summary("まず背景を確認します。次の動きも追いましょう！");
toneOnly.claim_refs.why_it_matters = ["C1"];
assert.doesNotThrow(() => assertToneOnlyRevisionContract(originalWithRefs, toneOnly), "語尾・テンションだけの差分は通す");
const changedMeaning = { ...toneOnly, why_it_matters: "まず背景を確認します。次の評価も追いましょう！" };
assert.throws(() => assertToneOnlyRevisionContract(originalWithRefs, changedMeaning), ToneOnlyRevisionContractError, "評価軸の変更は口調修正として通さない");
const changedRefs = { ...toneOnly, claim_refs: { ...toneOnly.claim_refs, why_it_matters: ["C2"] } };
assert.throws(() => assertToneOnlyRevisionContract(originalWithRefs, changedRefs), ToneOnlyRevisionContractError, "claim refsの変更は口調修正として通さない");

const issue26Original = "今回の注目は、公演ステージを全編ライブ配信するという新形式です。編集なしの一発勝負になるため、歌やダンスの実力がそのまま見えるのが魅力。特に、“唱功の頂点”とされる孫楠がダンスに挑む姿は、この緊張感あってこそ楽しめそうです。体力テストやチーム戦など新企画も加わり、シリーズがどう生まれ変わるのか、初回ライブの反応を追いたいです。";
const issue26ActualRevision = "待って、今季の『披荊斬棘』は公演が全編ライブ配信なんです！しかも初見面ライブが8月14日、初舞台ライブが8月15〜16日にもうすぐです。録画編集とは違う生の緊張感が楽しみすぎる！孫楠さんが「うまく踊れなかったら、下手に踊ればいい」みたいな名言を残したのもツボ。ただし、現時点では情報がこの1本だけなので、ほかのメディアの報道も確認してから本格的に判断したいと思っています。";
const issue26ToneOnlyRevision = "今回の注目は、公演ステージを全編ライブ配信するという新形式です！編集なしの一発勝負になるため、歌やダンスの実力がそのまま見えるのが魅力です！特に、“唱功の頂点”とされる孫楠がダンスに挑む姿は、この緊張感あってこそ楽しめそうですよ！体力テストやチーム戦など新企画も加わり、シリーズがどう生まれ変わるのか、初回ライブの反応を追いたいですね！";
const issue26Before = summary(issue26Original);
issue26Before.claim_refs.why_it_matters = ["C1", "C2"];
const issue26Changed = summary(issue26ActualRevision);
issue26Changed.claim_refs.why_it_matters = ["C1", "C2"];
assert.throws(
  () => assertToneOnlyRevisionContract(issue26Before, issue26Changed),
  ToneOnlyRevisionContractError,
  "#26で実際に生成された内容変更は、claim refsが同じでも口調修正として拒否する"
);
const issue26ToneOnly = summary(issue26ToneOnlyRevision);
issue26ToneOnly.claim_refs.why_it_matters = ["C1", "C2"];
assert.doesNotThrow(
  () => assertToneOnlyRevisionContract(issue26Before, issue26ToneOnly),
  "#26の各文と評価軸を保持した句読点・感嘆符・語尾だけの変更は通す"
);

const issue26Instruction = "落ち着きすぎず、「！」を使い、ビンタンがFalさんに「これ、見てほしいです！」と持ってきた期待が少し伝わる口調にしてください。事実内容は変えないでください。";
const issue26TonePrompt = formatToneOnlyReviewInstruction(issue26Instruction);
assert.equal(
  issue26TonePrompt.match(/これ、見てほしいです！/gu)?.length,
  1,
  "#26の引用句をプロンプト側で繰り返して挿入候補にしない"
);
assert.match(issue26TonePrompt, /挿入命令ではなく口調の参照例/u, "引用句をtone referenceとして扱うよう明記する");
assert.match(issue26TonePrompt, /内容語、文、事実、注目対象、評価軸を追加・削除・置換・再解釈しない/u, "内容変更を禁止する");
assert.match(issue26TonePrompt, /句読点、感嘆符、および既存文の語尾・丁寧さだけ/u, "機械gateと同じ変更範囲だけを許可する");

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
  const persistedBeforeAmbiguous = await fs.readFile(path.join(directory, "articles_2026-08-11.json"), "utf8");
  await assert.rejects(
    () => reviseStoredArticle(directory, 1, "日付と用語を正しくしてください。", "事実"),
    ReviewRevisionClarificationRequiredError,
    "対象を限定できない指示はclarificationで止める"
  );
  assert.equal(
    await fs.readFile(path.join(directory, "articles_2026-08-11.json"), "utf8"),
    persistedBeforeAmbiguous,
    "clarification時は保存前の元記事をバイト単位で保持する"
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log("lightweight review edit tests passed.");
