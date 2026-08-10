import assert from "node:assert/strict";
import { buildBingtangCommentPrompt } from "./summarizeWithGemini.js";
import { getToneMode } from "./toneMode.js";
import type { FactLedger, SummarizedArticle, TopicCandidate } from "./types.js";

const topic = {
  topic_key: "披荊斬棘2026",
  title_hint: "『披荊斬棘2026』が全編ライブ配信",
  event_sentence: "公演ステージを全編ライブ配信する新形式が発表された。",
  source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
  published_date_range: { earliest: "2026-08-08", latest: "2026-08-08" },
  freshness_label: "recent"
} as TopicCandidate;

const ledger = {
  topic_key: topic.topic_key,
  claims: [
    {
      id: "C1",
      type: "verified_fact",
      scope: "root_event",
      text: "公演ステージを全編ライブ配信する新形式が発表された。",
      evidence_refs: ["E1"],
      entities: ["披荊斬棘2026"],
      numbers: []
    },
    {
      id: "C2",
      type: "verified_fact",
      scope: "related_angle",
      angle_kind: "work_context",
      text: "関連人物について過去の訴訟が報じられた。",
      evidence_refs: ["E2"],
      entities: [],
      numbers: []
    }
  ],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
} satisfies FactLedger;

const summary = {
  lead: "新形式が発表されました。",
  what_happened: "公演ステージを全編ライブ配信します。",
  reaction_view: "",
  japan_context_note: ""
} as SummarizedArticle;

assert.equal(getToneMode(topic, ledger), "normal", "related-angle legal claim must not force sober tone");
assert.equal(
  getToneMode(topic, { ...ledger, claims: [{ ...ledger.claims[0], text: "公演中の事故が報じられた。" }] }),
  "sober",
  "root claim must still force sober tone"
);
assert.equal(
  getToneMode({ ...topic, title_hint: "出演者の訃報" }, { ...ledger, claims: [ledger.claims[0]] }),
  "sober",
  "title must still force sober tone"
);

const prompt = await buildBingtangCommentPrompt(topic, ledger, summary, "normal");
assert.match(prompt, /Character voice document \(docs\/character-bingtang-v2\.md\)/);
assert.match(prompt, /最大の喜びは、Falさんの「すげー、おもしれー！」/);
assert.match(prompt, /声・人格・Falさんとの関係性を表現するためだけ/);
assert.match(prompt, /記事選定、事実認定、根拠要件、安全規則、重大話題のトーン/);
assert.match(prompt, /「これを見せたかった」という期待が少し漏れる短いリアクションを1文必ず入れる/);
assert.match(prompt, /実際に観た・聴いた・現地で見たように書いたりしない/);

console.log("Bingtang comment tone tests passed");
