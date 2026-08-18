import assert from "node:assert/strict";
import { assessEvidenceIntegrity } from "./evidence/sourceIntegrity.js";
import { normalizeFactLedger } from "./factLedger.js";
import { ClaimCheckDiscardError } from "./claimCheck.js";
import { summarizeTopic } from "./summarizeWithGemini.js";
import type { RawArticle, TopicCandidate } from "./types.js";

const copiedPromo = "盼星星盼月亮，终于盼来了。这个阵容你期待吗？坐等开播见分晓！".repeat(8);
const evidence = [
  article("https://k.sina.com.cn/article_1.html", "B", "本文由AI生成特别声明。双平台预约量已破百万。"),
  article("https://www.163.com/dy/article/ABC.html", "C", `网易号 申请入驻 ${copiedPromo}`),
  article("https://news.qq.com/rain/a/ABC.html", "C", copiedPromo),
  { ...article("https://www.qidian.com/book/123", "A", "李长寿只想在洪荒安身立命，凡事谋而后动。"), sourceType: "official" as const }
];

const diagnostics = assessEvidenceIntegrity(evidence);
assert.equal(diagnostics[0]?.classification, "ai_generated");
assert.equal(diagnostics[0]?.usable_for_verified_facts, false);
assert.equal(diagnostics[1]?.classification, "platform_self_media");
assert.equal(diagnostics[2]?.classification, "promotional_or_repost");
assert.equal(diagnostics[2]?.duplicate_of, "E2", "same promotional copy on another portal is one repost, not corroboration");
assert.equal(diagnostics[3]?.classification, "primary");
assert.equal(diagnostics[3]?.usable_for_verified_facts, true);

const ledger = normalizeFactLedger({
  claims: [
    { id: "C1", type: "verified_fact", text: "予約数は100万件を突破した。", evidence_refs: ["E1"], entities: [], numbers: ["100万"], quote_zh: "双平台预约量已破百万" },
    { id: "C2", type: "verified_fact", text: "李長寿は危険を避け、物事をよく考えてから動く。", evidence_refs: ["E4"], entities: ["李长寿"], numbers: [], quote_zh: "凡事谋而后动" }
  ],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
}, "fixture", evidence.map((item) => item.rawContent).join("\n"), undefined, {
  E1: "root_corroboration", E2: "root_corroboration", E3: "root_corroboration", E4: "root_corroboration"
}, diagnostics);

assert.equal(ledger.claims.find((claim) => claim.id === "C1")?.type, "unsupported", "AI-generated promo cannot become a verified fact");
assert.equal(ledger.claims.find((claim) => claim.id === "C2")?.type, "verified_fact", "a primary-source premise remains usable");

const lowIntegrityTopic = {
  topic_key: "fixture",
  title_hint: "fixture",
  event_sentence: "fixture",
  main_entities: { people: [], works: ["作品"], organizations: [] },
  source_mix: {},
  evidence_articles: []
} as unknown as TopicCandidate;
await assert.rejects(
  () => summarizeTopic(lowIntegrityTopic, evidence.slice(0, 3), "deepseek"),
  ClaimCheckDiscardError,
  "全rootが低品質ならledger失敗時の全文生成へフォールバックせず、LLM呼び出し前に止める"
);

console.log("evidence integrity tests passed");

function article(url: string, reliability: RawArticle["reliability"], rawContent: string): RawArticle {
  return {
    title: "『作品』の紹介",
    url,
    sourceName: new URL(url).hostname,
    sourceUrl: url,
    category: "ドラマ",
    reliability,
    sourceType: "media_report",
    rawContent
  };
}
