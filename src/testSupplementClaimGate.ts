import assert from "node:assert/strict";
import { removeGatedViolationSentences, runClaimCheck } from "./claimCheck.js";
import type { FactLedger, SummarizedArticle } from "./types.js";

const ledger: FactLedger = {
  topic_key: "supplement-claim-gate",
  claims: [
    {
      id: "claim-valid",
      type: "verified_fact",
      text: "日本語圏の読者向けに補う文脈が確認できる。",
      evidence_refs: ["evidence-1"],
      entities: [],
      numbers: []
    }
  ],
  terms: [],
  japan_availability: {
    status: "not_in_evidence",
    detail: "",
    evidence_refs: []
  },
  unresolved: []
};

function makeSummary(note: string, refs: string[]): SummarizedArticle {
  return {
    title_ja: "テスト記事",
    badge: "NEWS",
    lead: "概要です。",
    what_happened: "出来事です。",
    why_it_matters: "注目点です。",
    reaction_view: "",
    editor_comment: "",
    japan_context_note: note,
    category: "映画",
    confidence: "A",
    source_type: "media_report",
    published_date: "2026-08-09",
    event_date: "2026-08-09",
    freshness_label: "today",
    newsworthiness_score: 80,
    japan_visibility: "low",
    japan_gap: "high",
    context_value: "high",
    sns_heat: "none",
    source_count: 1,
    source_list: [],
    has_official_source: false,
    has_multiple_sources: false,
    has_sns_signal: false,
    article_type: "news_event",
    skip_reason: "",
    verification_status: "verified",
    topic_key: ledger.topic_key,
    main_entities: { people: [], works: [], organizations: [] },
    related_sources: [],
    tags: [],
    publish_priority: "medium",
    publish_reason: "",
    claim_refs: {
      what_happened: [],
      why_it_matters: [],
      reaction_view: [],
      japan_context_note: refs
    }
  };
}

const emptyNoteResult = runClaimCheck(makeSummary("", []), ledger);
assert.equal(
  emptyNoteResult.violations.some((violation) => violation.rule === "japan_context_note_without_claim_ref"),
  false,
  "空の補足はclaim参照を要求しない"
);

const missingNoteSummary = makeSummary("", []);
missingNoteSummary.japan_context_note = undefined as unknown as string;
assert.doesNotThrow(() => runClaimCheck(missingNoteSummary, ledger), "旧データで補足フィールドが欠落しても例外にしない");
assert.equal(
  runClaimCheck(missingNoteSummary, ledger).violations.some((violation) => violation.rule === "japan_context_note_without_claim_ref"),
  false,
  "欠落した補足フィールドは空文字として扱う"
);

const validRefResult = runClaimCheck(makeSummary("補足として確認済みの文脈を紹介します。", ["claim-valid"]), ledger);
assert.equal(
  validRefResult.violations.some((violation) => violation.rule === "japan_context_note_without_claim_ref"),
  false,
  "有効なclaim参照が1件あれば補足を維持する"
);

for (const refs of [[], ["claim-unknown"]]) {
  const summary = makeSummary("根拠参照のない補足です。記事本文は残します。", refs);
  const result = runClaimCheck(summary, ledger);
  const violation = result.violations.find((item) => item.rule === "japan_context_note_without_claim_ref");
  assert.ok(violation, "有効なclaim参照が0件ならgateにする");
  assert.equal(violation.severity, "gate");

  const cleaned = removeGatedViolationSentences(summary, result.violations);
  assert.equal(cleaned.japan_context_note, "", "根拠のない補足だけを削除する");
  assert.deepEqual(cleaned.claim_refs.japan_context_note, [], "削除した補足のclaim参照も空にする");
  assert.equal(cleaned.what_happened, summary.what_happened, "記事本文は維持する");
  assert.equal(runClaimCheck(cleaned, ledger).gated_violation_count, 0, "補足削除後は再チェックを通過する");
}

console.log("supplement claim gate tests passed");
