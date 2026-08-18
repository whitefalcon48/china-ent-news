import assert from "node:assert/strict";
import { runCommentCheck, runClaimCheck } from "./claimCheck.js";
import { selectEditorialInsightClaims } from "./editorialInsight.js";
import { buildBingtangCommentPrompt } from "./summarizeWithGemini.js";
import type { FactLedger, SummarizedArticle, TopicCandidate } from "./types.js";

const topic = {
  topic_key: "作品配信",
  title_hint: "ドラマの配信日が決定",
  event_sentence: "ドラマの配信日が決まった。",
  source_mix: { official: 1, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
  main_entities: { people: [], works: ["作品"], organizations: [], events: [] },
  published_date_range: { earliest: "2026-08-18", latest: "2026-08-18" },
  freshness_label: "today"
} as unknown as TopicCandidate;

const ledger = {
  topic_key: topic.topic_key,
  claims: [
    claim("C1", "配信前の予約数が100万件を超えた。", "key_numbers", ["100万"]),
    claim("C2", "主人公は強さを誇るより、危険を避けて生き残ることを優先する。", "genre_contrast"),
    claim("C3", "主人公は外出前に何重もの備えをするため、その慎重さ自体が笑いになる。", "comic_mechanism"),
    claim("C4", "同じ原作は先にアニメ化され、複数シーズンが配信された。", "adaptation_context")
  ],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
} satisfies FactLedger;

assert.deepEqual(selectEditorialInsightClaims(ledger, ["C1"]).map((claim) => claim.id), ["C2", "C3", "C4"]);

const generic = runCommentCheck(
  "予約100万件は大きな数字です。ここから配信後の数字を見たいです！",
  "",
  ledger,
  topic,
  "normal",
  { bodyText: "予約100万件を超えた。", bodyClaimRefs: ["C1"], commentClaimRefs: ["C1"] }
);
assert.ok(generic.some((item) => item.rule === "comment_no_new_editorial_claim"));
assert.ok(generic.some((item) => item.rule === "comment_insight_claim_missing"));
assert.ok(generic.some((item) => item.rule === "comment_number_watch_template"));

const genreLabelOnly = runCommentCheck(
  "定番と違う主人公像が受け入れられるか、今後が気になります！",
  "",
  ledger,
  topic,
  "normal",
  { bodyText: "予約数と主人公像を説明した。", bodyClaimRefs: ["C1", "C2", "C3", "C4"], commentClaimRefs: ["C2"] }
);
assert.ok(
  genreLabelOnly.some((item) => item.rule === "comment_insight_claim_missing"),
  "抽象的なジャンル差だけで済ませず、物語上の仕掛けか映像化の具体claimを要求する"
);

const issue56Comment = runCommentCheck(
  "予約100万件は、原作ファンとドラマ新規の期待が重なった数字です。ここから配信後の初日再生数を見たいです。反套路の主人公像がどこまで受け入れられるか、私も気になります！",
  "",
  ledger,
  topic,
  "normal",
  { bodyText: "作品の設定と予約数を説明した。", bodyClaimRefs: ["C1", "C2", "C3", "C4"], commentClaimRefs: ["C1", "C2"] }
);
assert.ok(issue56Comment.some((item) => item.rule === "literal_translation_residue"), "Issue #56の反套路直書きを拒否する");
assert.ok(issue56Comment.some((item) => item.rule === "comment_insight_claim_missing"), "Issue #56の数字＋抽象ラベルだけの注目ポイントを拒否する");

const specific = runCommentCheck(
  "強くなるより生き残ることを選ぶ主人公が、何重にも備える。その慎重すぎる行動そのものが笑いになるのが面白いです！",
  "",
  ledger,
  topic,
  "normal",
  { bodyText: "予約100万件を超えた。", bodyClaimRefs: ["C1"], commentClaimRefs: ["C2", "C3"] }
);
assert.equal(specific.filter((item) => item.severity === "gate").length, 0, JSON.stringify(specific));

const sober = runCommentCheck(
  "確認できた事実と、まだ分かっていない点を分けて読む必要があります。",
  "",
  ledger,
  topic,
  "sober",
  { bodyText: "予約100万件を超えた。", bodyClaimRefs: ["C1"], commentClaimRefs: ["C1"] }
);
assert.equal(sober.filter((item) => item.severity === "gate").length, 0, "sober comments may use the same fact to mark a boundary without forced enthusiasm");

const literalSummary = summary({
  what_happened: "現象級小説を原作とする反套路仙侠軽喜劇で、脆いサラリーマンが病危になる。"
});
const literalViolations = runClaimCheck(literalSummary, ledger);
assert.ok(literalViolations.violations.filter((item) => item.rule === "literal_translation_residue").length >= 5);

const prompt = await buildBingtangCommentPrompt(topic, ledger, summary({ claim_refs: { what_happened: ["C1"], why_it_matters: [], reaction_view: [], japan_context_note: [] } }), "normal");
assert.match(prompt, /editorial_insight_candidates/);
assert.match(prompt, /本文で未使用のclaimを最低1件/);
assert.match(prompt, /「反套路」をそのまま日本語本文へ残さない/);

console.log("editorial insight and translation-quality tests passed");

function claim(id: string, text: string, editorial_role: NonNullable<FactLedger["claims"][number]["editorial_role"]>, numbers: string[] = []): FactLedger["claims"][number] {
  return { id, type: "verified_fact", text, evidence_refs: ["E1"], entities: [], numbers, quote_zh: text, anchor: true, scope: "root_event", editorial_role };
}

function summary(overrides: Partial<SummarizedArticle>): SummarizedArticle {
  return {
    title_ja: "作品記事", badge: "NEWS", lead: "配信日が決まった。", what_happened: "予約数が100万件を超えた。", why_it_matters: "", reaction_view: "", editor_comment: "", japan_context_note: "",
    category: "ドラマ", confidence: "A", source_type: "official", published_date: "2026-08-18", event_date: "", freshness_label: "today", newsworthiness_score: 70,
    japan_visibility: "unknown", japan_gap: "unknown", context_value: "medium", sns_heat: "none", source_count: 1, source_list: [], has_official_source: true,
    has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "verified", topic_key: topic.topic_key,
    main_entities: { people: [], works: ["作品"], organizations: [] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "",
    claim_refs: { what_happened: ["C1"], why_it_matters: [], reaction_view: [], japan_context_note: [] }, detail_sections: [], ...overrides
  };
}
