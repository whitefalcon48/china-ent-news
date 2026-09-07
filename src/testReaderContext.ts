import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceManifest,
  type BuildEvidenceManifestOptions,
  type ExplicitEvidenceImport
} from "./evidence/evidenceManifest.js";
import { buildReaderContextPlan, type ReaderContextSemanticReviewer } from "./quality/readerContext.js";
import type {
  EvidenceManifest,
  ReaderContextKind,
  ReaderContextRequest,
  ReaderContextSupportCandidate
} from "./quality/types.js";
import type { FactLedger, RawArticle, SummarizedArticle } from "./types.js";

type Fixture = {
  evidence: RawArticle[];
  provenance: NonNullable<BuildEvidenceManifestOptions["provenance"]>;
  summary: SummarizedArticle;
  ledger: FactLedger;
  definitions: Record<"organization" | "institution" | "industry", string>;
};

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await fs.readFile(path.resolve(root, "../tests/fixtures/stage-c/reader-context.json"), "utf8")) as Fixture;
const quotes = fixture.ledger.claims.map((claim) => ({
  claim_ref: claim.id,
  evidence_ref: claim.evidence_refs[0]!,
  quote: claim.quote_zh!,
  subject_quote: claim.quote_zh!
}));
const provenance = fixture.provenance.map((item, index) => index < 5 ? {
  ...item,
  extraction_quality: {
    status: "usable" as const,
    raw_chars: fixture.evidence[index]!.rawContent!.length,
    meaningful_chars: fixture.evidence[index]!.rawContent!.length,
    sentence_count: 4,
    boilerplate_ratio: 0,
    factual_anchor_count: 2
  }
} : item);
const built = buildEvidenceManifest(fixture.evidence, { provenance, quote_bindings: quotes });
const manifest = built.manifest;
const documentId = (ref: string) => {
  const value = manifest.evidence_bindings.find((item) => item.evidence_ref === ref)?.document_id;
  assert.ok(value, `${ref} must be bound to a document`);
  return value;
};
const claim = (id: string) => {
  const value = fixture.ledger.claims.find((item) => item.id === id);
  assert.ok(value?.quote_zh, `${id} must have a quote`);
  return value;
};
const support = (
  supportId: string,
  claimId: string,
  definition: string,
  options: { kind?: "claim" | "term"; evidenceRef?: string; document?: string; fetchedAt?: string | null; omitClaim?: boolean } = {}
): ReaderContextSupportCandidate => {
  const sourceClaim = claim(claimId);
  const evidenceRef = options.evidenceRef ?? sourceClaim.evidence_refs[0]!;
  const doc = options.document ?? documentId(evidenceRef);
  return {
    support_id: supportId,
    support_kind: options.kind ?? "claim",
    definition_ja: definition,
    evidence_ref: evidenceRef,
    document_id: doc,
    quote: sourceClaim.quote_zh!,
    subject_quote: sourceClaim.quote_zh!,
    ...(options.omitClaim ? {} : { claim_ref: claimId }),
    ...(options.fetchedAt === undefined ? {} : { fetched_at: options.fetchedAt })
  };
};
const request = (
  conceptId: string,
  term: string,
  kind: ReaderContextKind,
  occurrenceRef: string,
  occurrenceSpan: string,
  candidates: ReaderContextSupportCandidate[],
  necessity: ReaderContextRequest["necessity"] = "required",
  occurrenceDocument = documentId(occurrenceRef)
): ReaderContextRequest => ({
  concept_id: conceptId,
  term,
  aliases: [],
  kind,
  source_occurrences: [{ evidence_ref: occurrenceRef, document_id: occurrenceDocument, span: occurrenceSpan }],
  necessity,
  reason_ja: "日本語読者には役割が自明ではない",
  missing_understanding: "主体の役割",
  support_candidates: candidates
});

assert.equal(manifest.evidence_bindings[5]?.status, "unresolved_input");
assert.equal(manifest.documents.find((item) => item.document_id === documentId("E5"))?.integrity.classification, "ai_generated");
assert.equal(fixture.ledger.terms.length, 0, "terms空のfixtureを維持する");

const baseSnapshot = JSON.stringify({ evidence: fixture.evidence, manifest, ledger: fixture.ledger, summary: fixture.summary });
const semanticCalls: string[] = [];
const reviewer: ReaderContextSemanticReviewer = async ({ request: item }) => {
  semanticCalls.push(item.concept_id);
  if (item.concept_id === "same-name") return { status: "hold", reason_codes: ["subject_identity_mismatch"] };
  if (item.concept_id === "already") {
    return {
      status: "pass",
      definition_ja: fixture.definitions.institution,
      already_explained: true,
      existing_span: "中国電影資料館（映画資料の収集・保存・研究を担う国家級のアーカイブ機関）",
      reason_codes: ["existing_explanation_verified"]
    };
  }
  if (item.concept_id === "timeout") throw new Error("fixture timeout");
  const definitions: Record<string, string> = {
    organization: fixture.definitions.organization,
    industry: fixture.definitions.industry
  };
  return { status: "pass", definition_ja: definitions[item.concept_id], reason_codes: ["meaning_supported"] };
};

const mainRequests: ReaderContextRequest[] = [
  request(
    "organization",
    "国家安全部",
    "organization",
    "E1",
    claim("C1").quote_zh!,
    [support("S1", "C1", fixture.definitions.organization)]
  ),
  request("industry", "短劇", "industry_concept", "E3", claim("C3").quote_zh!, [support("S3", "C3", fixture.definitions.industry)]),
  request("already", "中国電影資料館", "institution", "E2", claim("C2").quote_zh!, [support("S2", "C2", fixture.definitions.institution)]),
  request("general", "映画", "industry_concept", "E2", "映画資料", [], "not_needed"),
  request("same-name", "星河中心", "institution", "E4", claim("C4").quote_zh!, [support("S4", "C4", "撮影支援施設。")]),
  request("missing", "国家安全部", "organization", "E1", claim("C1").quote_zh!, []),
  request("ai-body", "優酷", "institution", "E5", claim("C5").quote_zh!, [support("S5", "C5", "中国の動画配信サービス。")]),
  request("timeout", "中国電影資料館", "institution", "E2", claim("C2").quote_zh!, [support("S6", "C2", fixture.definitions.institution)])
];
const plan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: mainRequests,
  summary: fixture.summary,
  review_semantics: reviewer
});

assert.equal(plan.resolutions.length, 8);
assert.equal(plan.patches.length, 2, "organizationとindustryだけに限定patchを1件ずつ提案する");
const organization = plan.resolutions.find((item) => item.request_id === "organization")!;
assert.equal(organization.support_status, "support_ready", "terms空でも検証済みterm candidateを落とさない");
assert.equal(organization.semantic_review_status, "pass", "machine matchだけでpassにはしない");
assert.equal(organization.status, "resolved");
assert.equal(organization.origin, "input");
assert.equal(organization.outcome, "patch_proposed");
assert.equal(organization.patch?.field, "lead", "公開欄順で最初の出現だけを選ぶ");
assert.equal(organization.patch?.anchor, "国家安全部");
assert.equal(organization.patch?.scope, "root_event", "root本文の再利用はroot scopeを維持する");
assert.deepEqual(organization.patch?.claim_refs, ["C1"]);
assert.deepEqual(organization.patch?.evidence_refs, ["E1"]);
assert.equal(organization.support_spans[0]?.document_id, documentId("E1"));
assert.equal(organization.fetched_at, "2026-09-05T10:00:00.000Z");
assert.equal(organization.applicable_at, null, "記事公開日を制度の適用時点へ転記しない");
assert.equal(organization.source_published_at, "2026-09-05");
assert.deepEqual(organization.patch?.source_urls, ["https://official.example.cn/security/context"]);
assert.equal(plan.patches.filter((item) => item.concept_id === "organization").length, 1, "重複出現でもpatchを増やさない");
assert.equal(plan.resolutions.find((item) => item.request_id === "industry")?.outcome, "patch_proposed");
assert.equal(plan.resolutions.find((item) => item.request_id === "already")?.outcome, "already_explained");
assert.equal(plan.resolutions.find((item) => item.request_id === "already")?.patch, undefined);
assert.equal(plan.resolutions.find((item) => item.request_id === "general")?.outcome, "not_needed");
assert.equal(plan.resolutions.find((item) => item.request_id === "same-name")?.outcome, "hold", "同名別主体は意味審査で止める");
assert.equal(plan.resolutions.find((item) => item.request_id === "missing")?.outcome, "needs_research");
assert.equal(plan.resolutions.find((item) => item.request_id === "ai-body")?.outcome, "needs_research", "AI生成本文をcurrent supportへ昇格しない");
assert.equal(plan.resolutions.find((item) => item.request_id === "timeout")?.semantic_review_status, "unavailable");
assert.equal(plan.resolutions.find((item) => item.request_id === "timeout")?.outcome, "hold");
assert.equal(semanticCalls.includes("general"), false, "not_neededは意味審査しない");
assert.equal(semanticCalls.includes("missing"), false, "根拠欠損は意味審査しない");
assert.equal(semanticCalls.includes("ai-body"), false, "利用不能本文は意味審査しない");
assert.equal(JSON.stringify({ evidence: fixture.evidence, manifest, ledger: fixture.ledger, summary: fixture.summary }), baseSnapshot, "helperは入力を変更しない");
assert.equal(fixture.summary.source_count, 1, "root evidence再利用でsource_countを水増ししない");
assert.equal(plan.summary_hash, createHash("sha256").update(JSON.stringify(fixture.summary), "utf8").digest("hex"));

const termsEmptyPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("terms-empty", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("S-term", "C1", fixture.definitions.organization, { kind: "term" })])],
  summary: fixture.summary,
  review_semantics: async (reviewInput) => {
    reviewInput.summary.lead = "審査依存による変更";
    reviewInput.request.term = "変更";
    return { status: "pass", definition_ja: fixture.definitions.organization, reason_codes: ["meaning_supported"] };
  }
});
assert.equal(termsEmptyPlan.resolutions[0]?.support_status, "support_ready", "terms空でもdocument検証済みterm supportを意味審査へ渡す");
assert.equal(termsEmptyPlan.resolutions[0]?.semantic_review_status, "pass");
assert.equal(fixture.summary.lead.startsWith("国家安全部"), true, "注入した審査依存にも入力summary/requestを変更させない");

const unexplainedSummary = structuredClone(fixture.summary);
unexplainedSummary.what_happened = "中国電影資料館と優酷も関連情報を公開した。";
const institutionPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("institution", "中国電影資料館", "institution", "E2", claim("C2").quote_zh!, [support("S7", "C2", fixture.definitions.institution)], "optional")],
  summary: unexplainedSummary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.institution, reason_codes: ["meaning_supported"] })
});
assert.equal(institutionPlan.resolutions[0]?.outcome, "patch_proposed", "組織名に限定せず機関候補も扱う");
assert.equal(institutionPlan.resolutions[0]?.necessity, "optional", "optional判定を保持する");

const revisePlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("revise", "短劇", "industry_concept", "E3", claim("C3").quote_zh!, [support("S8", "C3", fixture.definitions.industry)])],
  summary: fixture.summary,
  review_semantics: async () => ({ status: "revise", definition_ja: "表現を調整する必要がある。", reason_codes: ["wording_too_broad"] })
});
assert.equal(revisePlan.resolutions[0]?.support_status, "support_ready");
assert.equal(revisePlan.resolutions[0]?.outcome, "revise");
assert.equal(revisePlan.patches.length, 0);

const importLedger: FactLedger = {
  topic_key: "imported-context",
  claims: [{
    id: "C7",
    type: "verified_fact",
    text: "保存済みの説明",
    evidence_refs: ["E7"],
    source_name: "保存済み資料",
    entities: ["国家安全部"],
    numbers: [],
    quote_zh: "保存済みの説明引用",
    scope: "related_angle"
  }],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: [],
  evidence_roles: { E7: "related_angle" },
  evidence_quality: [{ evidence_ref: "E7", classification: "editorial_media", usable_for_verified_facts: true, reason: "fixture_reviewed" }]
};
const importedBodyHash = createHash("sha256").update("保存済みの説明引用", "utf8").digest("hex");
const imported: ExplicitEvidenceImport = {
  validation_origin: "stored_review_supplement",
  supplement: {
    term: "国家安全部",
    definition_ja: "保存済み説明。",
    source_url: "https://stored.example.cn/context",
    source_name: "保存済み資料",
    source_title: "保存済み資料",
    source_published_date: "2026-08-30",
    fetched_at: "2026-09-01T00:00:00.000Z",
    body_sha256: importedBodyHash,
    source_quote: "保存済みの説明引用",
    subject_quote: "保存済みの説明引用",
    evidence_ref: "E7",
    claim_ref: "C7",
    reason: "fixture",
    reviewed_by: "fixture-operator",
    verification: "operator_reviewed_exact_quotes"
  },
  ledger: importLedger
};
const importedManifest = buildEvidenceManifest(fixture.evidence, { provenance, quote_bindings: quotes, imports: [imported] }).manifest;
const importedBinding = importedManifest.evidence_bindings.find((item) => item.evidence_ref === "E7")!;
const storedPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest: importedManifest,
  ledger: fixture.ledger,
  requests: [request("stored-only", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [{
    support_id: "S9",
    support_kind: "claim",
    definition_ja: "保存済み説明。",
    evidence_ref: "E7",
    document_id: importedBinding.document_id!,
    quote: "保存済みの説明引用",
    subject_quote: "保存済みの説明引用",
    claim_ref: "C7"
  }])],
  summary: fixture.summary,
  review_semantics: async () => { throw new Error("must not run"); }
});
assert.equal(storedPlan.resolutions[0]?.outcome, "needs_research", "保存済みsupplementだけをcurrent supportへ昇格しない");

const unresolvedPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("unresolved", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [{
    support_id: "S10",
    support_kind: "term",
    definition_ja: fixture.definitions.organization,
    evidence_ref: "E6",
    document_id: "doc-unresolved",
    quote: "本文欠損",
    subject_quote: "本文欠損"
  }])],
  summary: fixture.summary,
  review_semantics: async () => { throw new Error("must not run"); }
});
assert.equal(unresolvedPlan.resolutions[0]?.outcome, "needs_research", "unresolved_inputをreview済みへ昇格しない");

const mismatchPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("e-mismatch", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("S11", "C1", fixture.definitions.organization)], "required", documentId("E2"))],
  summary: fixture.summary,
  review_semantics: async () => { throw new Error("must not run"); }
});
assert.equal(mismatchPlan.resolutions[0]?.outcome, "hold");
assert.equal(mismatchPlan.diagnostics[0]?.code, "source_occurrence_ref_mismatch");

const idRequests = Array.from({ length: 9 }, (_, index) => request(
  `limit-${index + 1}`,
  "映画",
  "industry_concept",
  "E2",
  "映画資料",
  [],
  "not_needed"
));
const limitPlan = await buildReaderContextPlan({ evidence: fixture.evidence, manifest, ledger: fixture.ledger, requests: idRequests, summary: fixture.summary, review_semantics: reviewer });
assert.equal(limitPlan.holds.length, 9);
assert.equal(limitPlan.diagnostics.every((item) => item.code === "too_many_context_requests"), true);

const invalidId = request("bad id", "映画", "industry_concept", "E2", "映画資料", [], "not_needed");
const duplicateA = request("duplicate", "映画", "industry_concept", "E2", "映画資料", [], "not_needed");
const duplicateB = structuredClone(duplicateA);
const invalidPlan = await buildReaderContextPlan({ evidence: fixture.evidence, manifest, ledger: fixture.ledger, requests: [invalidId, duplicateA, duplicateB], summary: fixture.summary, review_semantics: reviewer });
assert.deepEqual(invalidPlan.diagnostics.map((item) => item.code), ["concept_id_invalid", "concept_id_duplicate"]);

const rangePlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("range", "国家安全部", "organization", "E1", "長".repeat(401), [support("S12", "C1", fixture.definitions.organization)])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(rangePlan.diagnostics[0]?.code, "source_occurrence_invalid");

const duplicateSummary = structuredClone(fixture.summary);
duplicateSummary.lead = `中国電影資料館（${fixture.definitions.institution}）が発表した。`;
duplicateSummary.what_happened = `中国電影資料館（${fixture.definitions.institution}）も関連情報を公開した。`;
const duplicatePlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("duplicate-explanation", "中国電影資料館", "institution", "E2", claim("C2").quote_zh!, [support("S13", "C2", fixture.definitions.institution)])],
  summary: duplicateSummary,
  review_semantics: async () => ({
    status: "pass",
    definition_ja: fixture.definitions.institution,
    already_explained: true,
    existing_span: `中国電影資料館（${fixture.definitions.institution}）`,
    reason_codes: ["existing_explanation_verified"]
  })
});
assert.equal(duplicatePlan.patches.length, 0, "既存の重複説明に新しい説明を重ねない");
assert.equal(duplicatePlan.resolutions[0]?.outcome, "already_explained");

const timeMismatchPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("time-mismatch", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("S14", "C1", fixture.definitions.organization, { fetchedAt: "2026-09-06T00:00:00.000Z" })])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(timeMismatchPlan.resolutions[0]?.outcome, "hold", "モデル由来の取得時点をmanifest値へすり替えない");
assert.equal(timeMismatchPlan.diagnostics[0]?.code, "support_fetched_at_mismatch");

const invalidReviewPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("invalid-review", "短劇", "industry_concept", "E3", claim("C3").quote_zh!, [support("S15", "C3", fixture.definitions.industry)])],
  summary: fixture.summary,
  review_semantics: async () => ({ status: "pass", definition_ja: 42, reason_codes: [] } as unknown as Awaited<ReturnType<ReaderContextSemanticReviewer>>)
});
assert.equal(invalidReviewPlan.resolutions[0]?.outcome, "hold", "不正な意味審査schemaを未審査passにしない");
assert.equal(invalidReviewPlan.diagnostics[0]?.code, "semantic_review_invalid");

// R1: term support must not bypass the C -> E -> document contract.
const wrongClaimSupport = support("R1-C999", "C1", fixture.definitions.organization, { kind: "term" });
wrongClaimSupport.claim_ref = "C999";
const wrongClaimPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r1-c999", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [wrongClaimSupport])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(wrongClaimPlan.resolutions[0]?.outcome, "hold");
assert.equal(wrongClaimPlan.diagnostics[0]?.code, "support_claim_ref_mismatch");

const noClaimPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r1-no-c", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R1-no-C", "C1", fixture.definitions.organization, { kind: "term", omitClaim: true })])],
  summary: fixture.summary,
  review_semantics: async () => { throw new Error("claim binding前に意味審査を呼ばない"); }
});
assert.equal(noClaimPlan.resolutions[0]?.support_status, "support_ready", "原文spanの機械確認結果は保持する");
assert.equal(noClaimPlan.resolutions[0]?.status, "held");
assert.equal(noClaimPlan.resolutions[0]?.reason_codes[0], "claim_binding_required");
assert.equal(noClaimPlan.patches.length, 0);

const wrongEvidenceClaim = support("R1-wrong-E", "C2", fixture.definitions.institution, { kind: "term" });
wrongEvidenceClaim.claim_ref = "C1";
const wrongEvidenceClaimPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r1-wrong-e", "中国電影資料館", "institution", "E2", claim("C2").quote_zh!, [wrongEvidenceClaim])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(wrongEvidenceClaimPlan.diagnostics[0]?.code, "support_claim_ref_mismatch");

const unsupportedLedger = structuredClone(fixture.ledger);
unsupportedLedger.claims.find((item) => item.id === "C4")!.type = "unsupported";
const unsupportedPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: unsupportedLedger,
  requests: [request("r1-unsupported", "星河中心", "institution", "E4", claim("C4").quote_zh!, [support("R1-unsupported", "C4", "上海の撮影支援施設。", { kind: "term" })])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(unsupportedPlan.resolutions[0]?.outcome, "needs_research");
assert.equal(unsupportedPlan.diagnostics[0]?.code, "support_claim_unusable");

const wrongScopeLedger = structuredClone(fixture.ledger);
wrongScopeLedger.claims.find((item) => item.id === "C1")!.scope = "related_angle";
const wrongScopePlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: wrongScopeLedger,
  requests: [request("r1-scope", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R1-scope", "C1", fixture.definitions.organization, { kind: "term" })])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(wrongScopePlan.diagnostics[0]?.code, "support_claim_scope_mismatch");

const invalidKindSupport = support("R1-kind", "C1", fixture.definitions.organization);
invalidKindSupport.support_kind = "other" as ReaderContextSupportCandidate["support_kind"];
const invalidKindPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r1-kind", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [invalidKindSupport])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(invalidKindPlan.diagnostics[0]?.code, "support_kind_invalid");
assert.equal(termsEmptyPlan.resolutions[0]?.outcome, "patch_proposed", "正しいC付きtermはterms空でも解決できる");

// R2: current evidence bytes and URL provenance must still match the manifest.
const changedRootEvidence = structuredClone(fixture.evidence);
changedRootEvidence[0]!.rawContent = "国家安全部の別の記事。旧引用の説明は含まれない。";
const staleRootPlan = await buildReaderContextPlan({
  evidence: changedRootEvidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r2-root", "国家安全部", "organization", "E1", "国家安全部", [support("R2-root", "C1", fixture.definitions.organization)])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(staleRootPlan.resolutions[0]?.outcome, "hold");
assert.equal(staleRootPlan.diagnostics[0]?.code, "source_occurrence_version_mismatch");

const changedSupportEvidence = structuredClone(fixture.evidence);
changedSupportEvidence[1]!.rawContent = "中国電影資料館についての別版本文。旧引用はない。";
const staleRelatedPlan = await buildReaderContextPlan({
  evidence: changedSupportEvidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r2-related", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R2-related", "C2", fixture.definitions.institution)])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(staleRelatedPlan.resolutions[0]?.outcome, "hold");
assert.equal(staleRelatedPlan.diagnostics[0]?.code, "input_body_hash_mismatch");

const redirectProvenance = structuredClone(provenance);
redirectProvenance[0] = {
  ...redirectProvenance[0]!,
  requested_url: fixture.evidence[0]!.url,
  final_url: "https://cdn.official.example.cn/security/context"
};
const redirectManifest = buildEvidenceManifest(fixture.evidence, { provenance: redirectProvenance, quote_bindings: quotes }).manifest;
const redirectDoc = redirectManifest.evidence_bindings[0]!.document_id!;
const redirectCandidate = support("R2-redirect", "C1", fixture.definitions.organization);
redirectCandidate.document_id = redirectDoc;
const redirectPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest: redirectManifest,
  ledger: fixture.ledger,
  requests: [request("r2-redirect", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [redirectCandidate], "required", redirectDoc)],
  summary: fixture.summary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.organization, reason_codes: ["meaning_supported"] })
});
assert.equal(redirectPlan.resolutions[0]?.outcome, "patch_proposed", "requested URLとfinal URLの正当なredirectを許容する");
assert.deepEqual(redirectPlan.resolutions[0]?.patch?.source_urls, ["https://cdn.official.example.cn/security/context"]);

// R3: duplicate concept patches merge, while conflicting definitions hold all proposals.
const duplicateRequests = ["one", "two"].map((id) => request(
  `r3-${id}`,
  "国家安全部",
  "organization",
  "E1",
  claim("C1").quote_zh!,
  [support(`R3-${id}`, "C1", fixture.definitions.organization)]
));
const duplicateRequestPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: duplicateRequests,
  summary: fixture.summary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.organization, reason_codes: ["meaning_supported"] })
});
assert.equal(duplicateRequestPlan.patches.length, 1, "同語別IDから同じanchorへ2patchを出さない");
assert.deepEqual(duplicateRequestPlan.resolutions.map((item) => item.outcome), ["patch_proposed", "merged"]);

const aliasRequest = request("r3-alias", "同部門", "organization", "E1", "同部門は2026年9月5日", [support("R3-alias", "C1", fixture.definitions.organization)]);
aliasRequest.aliases = ["国家安全部"];
const aliasMergePlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [duplicateRequests[0]!, aliasRequest],
  summary: fixture.summary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.organization, reason_codes: ["meaning_supported"] })
});
assert.equal(aliasMergePlan.patches.length, 1, "aliasが重なる同一概念も1patchへ統合する");

const conflictPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: duplicateRequests,
  summary: fixture.summary,
  review_semantics: async ({ request: item }) => ({
    status: "pass",
    definition_ja: item.concept_id.endsWith("one") ? fixture.definitions.organization : "中国の映像制作会社。",
    reason_codes: ["meaning_supported"]
  })
});
assert.equal(conflictPlan.patches.length, 0, "同一初出へ矛盾する説明を残さない");
assert.deepEqual(conflictPlan.resolutions.map((item) => item.outcome), ["hold", "hold"]);
assert.equal(conflictPlan.diagnostics.some((item) => item.code === "context_patch_conflict"), true);

// R4: use canonical C1-a order and bind an existing explanation to the first occurrence itself.
const orderSummary = structuredClone(fixture.summary);
orderSummary.lead = "映像制作現場への注意事項が公表された。";
orderSummary.what_happened = "関係機関が資料を公開した。";
orderSummary.reaction_view = "短劇の制作会社からの反応は確認されていない。";
orderSummary.why_it_matters = "短劇の配信動向にも関係する。";
let reviewedFirstField = "";
const orderPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r4-order", "短劇", "industry_concept", "E3", claim("C3").quote_zh!, [support("R4-order", "C3", fixture.definitions.industry)])],
  summary: orderSummary,
  review_semantics: async ({ first_occurrence }) => {
    reviewedFirstField = first_occurrence.field;
    return { status: "pass", definition_ja: fixture.definitions.industry, reason_codes: ["meaning_supported"] };
  }
});
assert.equal(orderPlan.patches[0]?.field, "reaction_view");
assert.equal(reviewedFirstField, "reaction_view", "意味審査へ初出fieldと位置を渡す");

const laterExplanationSummary = structuredClone(fixture.summary);
laterExplanationSummary.lead = "国家安全部が注意事項を公表した。";
laterExplanationSummary.what_happened = `国家安全部（${fixture.definitions.organization}）が確認手順を説明した。`;
const laterExplanationPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r4-later-field", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R4-later-field", "C1", fixture.definitions.organization)])],
  summary: laterExplanationSummary,
  review_semantics: async () => ({
    status: "pass",
    definition_ja: fixture.definitions.organization,
    already_explained: true,
    existing_span: `国家安全部（${fixture.definitions.organization}）`,
    reason_codes: ["existing_explanation_verified"]
  })
});
assert.equal(laterExplanationPlan.resolutions[0]?.outcome, "hold", "後段欄の説明で裸の初出をresolvedにしない");
assert.equal(laterExplanationPlan.diagnostics[0]?.code, "existing_explanation_not_at_first_occurrence");

const farExplanationSummary = structuredClone(fixture.summary);
farExplanationSummary.lead = `国家安全部が公表した。${"別の説明。".repeat(20)}国家安全部（${fixture.definitions.organization}）が確認手順を示した。`;
const farExplanationPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r4-far", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R4-far", "C1", fixture.definitions.organization)])],
  summary: farExplanationSummary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.organization, already_explained: true, existing_span: `国家安全部（${fixture.definitions.organization}）`, reason_codes: [] })
});
assert.equal(farExplanationPlan.diagnostics[0]?.code, "existing_explanation_not_at_first_occurrence");

const otherConceptSummary = structuredClone(fixture.summary);
otherConceptSummary.lead = `国家安全部が公表した。中国電影資料館（${fixture.definitions.institution}）も資料を公開した。`;
const otherConceptPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r4-other", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [support("R4-other", "C1", fixture.definitions.organization)])],
  summary: otherConceptSummary,
  review_semantics: async () => ({ status: "pass", definition_ja: fixture.definitions.organization, already_explained: true, existing_span: `中国電影資料館（${fixture.definitions.institution}）`, reason_codes: [] })
});
assert.equal(otherConceptPlan.diagnostics[0]?.code, "existing_explanation_concept_mismatch");

// R5: publication/fetch timestamps stay separate from an unverified applicability date.
const applicabilitySupport = support("R5-applicable", "C1", fixture.definitions.organization);
applicabilitySupport.applicable_at = "2026-10-01";
const applicabilityPlan = await buildReaderContextPlan({
  evidence: fixture.evidence,
  manifest,
  ledger: fixture.ledger,
  requests: [request("r5-applicable", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [applicabilitySupport])],
  summary: fixture.summary,
  review_semantics: reviewer
});
assert.equal(applicabilityPlan.resolutions[0]?.outcome, "hold");
assert.equal(applicabilityPlan.diagnostics[0]?.code, "support_applicable_at_unverified");
assert.equal(applicabilityPlan.resolutions[0]?.applicable_at, null);

const noPublishedEvidence = structuredClone(fixture.evidence);
delete noPublishedEvidence[0]!.publishedDate;
const noPublishedManifest = buildEvidenceManifest(noPublishedEvidence, { provenance, quote_bindings: quotes }).manifest;
const noPublishedDoc = noPublishedManifest.evidence_bindings[0]!.document_id!;
const noPublishedSupport = support("R5-no-published", "C1", fixture.definitions.organization);
noPublishedSupport.document_id = noPublishedDoc;
let reviewedSourceTime: { source_published_at: string | null; fetched_at: string | null; applicable_at: null } | undefined;
const noPublishedPlan = await buildReaderContextPlan({
  evidence: noPublishedEvidence,
  manifest: noPublishedManifest,
  ledger: fixture.ledger,
  requests: [request("r5-no-published", "国家安全部", "organization", "E1", claim("C1").quote_zh!, [noPublishedSupport], "required", noPublishedDoc)],
  summary: fixture.summary,
  review_semantics: async ({ source }) => {
    reviewedSourceTime = { source_published_at: source.source_published_at, fetched_at: source.fetched_at, applicable_at: source.applicable_at };
    return { status: "pass", definition_ja: fixture.definitions.organization, reason_codes: ["meaning_supported"] };
  }
});
assert.deepEqual(reviewedSourceTime, { source_published_at: null, fetched_at: "2026-09-05T10:00:00.000Z", applicable_at: null });
assert.equal(noPublishedPlan.resolutions[0]?.source_published_at, null);
assert.equal(noPublishedPlan.resolutions[0]?.fetched_at, "2026-09-05T10:00:00.000Z");
assert.equal(noPublishedPlan.resolutions[0]?.applicable_at, null);

console.log("ReaderContext C1-a: candidate, document support, semantic review, limited patch and safe holds passed");
