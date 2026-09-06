import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { inferUnquotedInstructionAnchor } from "./review/instructionAnchors.js";
import { parseReviewComment } from "./review/parseReviewComment.js";
import {
  ReviewRevisionClarificationRequiredError,
  applyValidatedReviewPatch,
  buildLimitedReviewPatchPrompt,
  detectReviewRevisionIntent
} from "./review/revisionPatch.js";
import { generateAndApplyLimitedReviewPatch } from "./review/reviseArticle.js";
import type { FactLedger, ProcessedArticle, SummarizedArticle } from "./types.js";

const fixtureDirectory = path.resolve("data/2026-09-06");
const articles = JSON.parse(await fs.readFile(path.join(fixtureDirectory, "articles_2026-09-06.json"), "utf8")) as ProcessedArticle[];
const first = articles[0];
const before = first.summary!;
const frozenBefore = structuredClone(before);
const ledgers = JSON.parse(await fs.readFile(path.join(fixtureDirectory, "fact_ledger_2026-09-06.json"), "utf8")) as { ledgers: Array<{ topic_key: string; ledger: FactLedger }> };
const ledger = ledgers.ledgers.find((item) => item.topic_key === first.topic?.topic_key)?.ledger;
assert.ok(ledger, "#83 fixture の fact ledger を読み込める");

const originalOwnerInstruction = "1 修正 事実がただ並べられているだけでわかりにくい。中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視など列挙している部分はいらないので、国家安全部とはなにか普通の人は知らない前提で。";
const parsedOwnerInstruction = parseReviewComment(originalOwnerInstruction);
assert.equal(parsedOwnerInstruction.decisions.length, 1);
assert.equal(parsedOwnerInstruction.decisions[0]?.action, "revision_requested");
assert.equal(parsedOwnerInstruction.decisions[0]?.reasonTag, "その他");
assert.equal(parsedOwnerInstruction.decisions[0]?.comment, "事実がただ並べられているだけでわかりにくい。中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視など列挙している部分はいらないので、国家安全部とはなにか普通の人は知らない前提で。");
const originalComment = parsedOwnerInstruction.decisions[0]!.comment;
const originalIntent = detectReviewRevisionIntent(before, originalComment, "その他");
assert.equal(originalIntent.mode, "limited_patch");
assert.deepEqual(originalIntent.allowed_fields, ["what_happened"]);
assert.deepEqual(originalIntent.explicit_fields, []);
assert.deepEqual(originalIntent.required_field_rewrites, []);

const deletionInstruction = "1 修正 中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視などの制作団体の列挙を削除してください。他の文は変えないでください。";
const deletionIntent = detectReviewRevisionIntent(before, deletionInstruction, "その他");
assert.equal(deletionIntent.mode, "limited_patch");
assert.deepEqual(deletionIntent.allowed_fields, ["what_happened"], "先頭の番号を含む自然文でも本文だけに限定する");
assert.deepEqual(deletionIntent.required_replacements, []);
assert.deepEqual(deletionIntent.required_field_rewrites, []);

const practicalDeletionInstruction = "1 修正 本文の制作団体の列挙を削除してください。国家安全部が制作を主導した点と、ほかの文は残してください。";
const practicalDeletionIntent = detectReviewRevisionIntent(before, practicalDeletionInstruction, "その他");
assert.equal(practicalDeletionIntent.mode, "limited_patch");
assert.deepEqual(practicalDeletionIntent.allowed_fields, ["what_happened"], "欄名だけの実用的な削除指示も本文だけに限定する");

const removedList = "国家安全部が主導して制作され、中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視などが制作に関わる。";
const deletionDocument = {
  mode: "limited_patch" as const,
  clarification_required: false,
  clarification_reason: "",
  patches: [{ field: "what_happened" as const, operation: "replace" as const, before: removedList, after: "国家安全部が主導して制作された。", evidence_claim_refs: ["C2"], reason: "制作団体の列挙だけを削除" }]
};
const practicalDeletionDocument = {
  ...deletionDocument,
  patches: [{
    ...deletionDocument.patches[0],
    before: "国家安全部が主導して制作され、中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視などが制作に関わる。",
    after: "国家安全部が主導して制作された。"
  }]
};
const deletionResult = applyValidatedReviewPatch(before, first.topic!, ledger!, deletionInstruction, "その他", deletionIntent, deletionDocument);
assert.deepEqual(
  deletionResult.summary,
  { ...before, what_happened: before.what_happened.replace(removedList, "国家安全部が主導して制作された。") },
  "列挙の置換以外は本文残部・ソース配列・メタデータを含め完全一致で保持する"
);
assert.equal(deletionResult.summary.what_happened.includes("中央広播電視総台"), false);
assert.equal(deletionResult.summary.what_happened.includes("国家安全部が主導して制作された。"), true, "制作主導の事実を残す");
assert.equal(deletionResult.summary.what_happened.includes("監督は姚暁峰"), true, "本文の残部を保持する");
assert.equal(deletionResult.summary.lead, before.lead);
assert.deepEqual(deletionResult.summary.source_list, before.source_list);
assert.deepEqual(deletionResult.summary.claim_refs, before.claim_refs);
assert.equal(deletionResult.summary.reaction_view, "", "空の反応欄を追加しない");
const practicalDeletionResult = applyValidatedReviewPatch(before, first.topic!, ledger!, practicalDeletionInstruction, "その他", practicalDeletionIntent, practicalDeletionDocument);
assert.equal(practicalDeletionResult.summary.what_happened.includes("国家安全部が主導して制作され"), true, "制作主導の事実を残す");
assert.equal(practicalDeletionResult.summary.what_happened.includes("中央広播電視総台"), false, "列挙だけを除くfixture patchを検証する");

assert.throws(
  () => applyValidatedReviewPatch(before, first.topic!, ledger!, deletionInstruction, "その他", deletionIntent, {
    ...deletionDocument,
    patches: [{ ...deletionDocument.patches[0], before: before.what_happened.slice(0, Math.ceil(before.what_happened.length * 0.7)), after: "短縮文" }]
  }),
  /範囲を超えて/u,
  "明示されない65%超のreplaceを拒否する"
);
assert.throws(
  () => applyValidatedReviewPatch(before, first.topic!, ledger!, deletionInstruction, "その他", deletionIntent, {
    ...deletionDocument,
    patches: [{ ...deletionDocument.patches[0], operation: "replace_field", before: before.what_happened, after: "全置換" }]
  }),
  /フィールド全体の置換/u,
  "明示的な再構成でないreplace_fieldを拒否する"
);

const naturalFields = [
  { field: "what_happened", value: "架空の別記事本文には独立した説明対象となる長い文があります。続きです。" },
  { field: "why_it_matters", value: "別の説明対象となる長文です。" }
] as const;
assert.deepEqual(
  inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文を短くしてください"),
  { field: "what_happened", anchor: "架空の別記事本文には独立した説明対象となる長い文" },
  "引用符なしの独立した架空文でも一意なら対象を推定する"
);
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "説明対象を短くしてください"), null, "曖昧な短語を拒否する");
assert.equal(inferUnquotedInstructionAnchor([{ field: "lead", value: "同じ長い文章がここにもあります。" }, { field: "what_happened", value: "同じ長い文章がここにもあります。" }], "同じ長い文章がここにもありますを短くしてください"), null, "同文が別fieldなら拒否する");
assert.equal(inferUnquotedInstructionAnchor([{ field: "what_happened", value: "同じ長い文章がここにもあります。同じ長い文章がここにもあります。" }], "同じ長い文章がここにもありますを短くしてください"), null, "同field内に二回なら拒否する");
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文は削除せず、変更しません。"), null, "保持指示から対象を補完しない");
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文の説明は不要なので変えないでください。"), null, "否定の説明要求から対象を補完しない");
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文は消さないでください。"), null, "消さない保持指示から対象を補完しない");
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文は外さないでください。"), null, "外さない保持指示から対象を補完しない");
assert.equal(inferUnquotedInstructionAnchor(naturalFields, "架空の別記事本文には独立した説明対象となる長い文を短くし、別の説明対象となる長文ですを分かりやすく説明してください"), null, "mixed residual は複数対象として拒否する");
assert.equal(inferUnquotedInstructionAnchor([{ field: "what_happened", value: "非常に長い一致対象の文章と、独立した短めの一致対象があります。" }], "非常に長い一致対象の文章を削除してください。独立した短めの一致対象も消してください。"), null, "同fieldの長い一致と独立した短い一致を両方拾う場合は曖昧停止する");
assert.equal(detectReviewRevisionIntent(before, originalComment, "その他", { directDestinationOnly: true }).mode, "clarification_required", "mixed residualは明示欄名がなければ推定せず停止する");

// The injected generator exercises the model clarification route without an API call.
let generatorCalls = 0;
await assert.rejects(
  generateAndApplyLimitedReviewPatch(before, first.topic!, ledger!, originalComment, "その他", originalIntent, async () => {
    generatorCalls += 1;
    return { mode: "limited_patch", clarification_required: true, clarification_reason: "用語説明の根拠がない", patches: [] };
  }),
  ReviewRevisionClarificationRequiredError,
  "根拠不足は clarification で停止する"
);
assert.equal(generatorCalls, 1, "clarification は1回で止まり実APIを呼ばない");
assert.deepEqual(before, frozenBefore, "失敗時に原稿fixtureを変更しない");

// Synthetic fixture: organization names and roles are fictional. Unlike #83's
// ledger, this fixture deliberately has an anchored role-description claim.
const synthetic = { ...before, what_happened: "架空制作協会、架空配給協会などの団体名が列挙されている。甲社は制作を、乙社は配給を担当した。", claim_refs: { ...before.claim_refs, what_happened: ["C_ROLE"] } } as SummarizedArticle;
const syntheticLedger: FactLedger = { ...ledger!, claims: [...ledger!.claims, { id: "C_ROLE", type: "verified_fact", text: "甲社は制作を担当し、乙社は配給を担当した。", evidence_refs: ["E1"], entities: ["甲社", "乙社"], numbers: [], anchor: true }], terms: [] };
const syntheticInstruction = "本文の架空制作協会、架空配給協会などの団体名の列挙を削除し、甲社は制作、乙社は配給という役割を説明してください。";
const syntheticIntent = detectReviewRevisionIntent(synthetic, syntheticInstruction, "その他");
assert.equal(syntheticIntent.mode, "limited_patch", "複合指示の成功例は実記事と分離したsynthetic fixtureで扱う");
if (syntheticIntent.mode === "limited_patch") {
  const syntheticResult = applyValidatedReviewPatch(synthetic, first.topic!, syntheticLedger, syntheticInstruction, "その他", syntheticIntent, {
    mode: "limited_patch", clarification_required: false, clarification_reason: "",
    patches: [{ field: "what_happened", operation: "replace", before: synthetic.what_happened, after: "甲社は制作を、乙社は配給を担当した。", evidence_claim_refs: ["C_ROLE"], reason: "synthetic role explanation" }]
  });
  assert.equal(syntheticResult.summary.what_happened.includes("架空制作協会"), false, "明示削除を合成patchで反映する");
  assert.deepEqual(syntheticResult.summary.lead, synthetic.lead, "非対象欄を完全一致で保持する");
}

const prompt = buildLimitedReviewPatchPrompt(before, ledger!, originalComment, originalIntent);
assert.match(prompt, /複数の要望.*全件/u, "promptが複数要求の全件充足を要求する");
assert.match(prompt, /名称や関与事実.*意味や役割の説明の根拠/u, "promptが名称と役割説明の根拠を区別する");

console.log("natural review instruction tests passed");
