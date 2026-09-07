import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceManifest,
  EvidenceManifestConflictError,
  type BuildEvidenceManifestOptions,
  type ExplicitEvidenceImport
} from "./evidence/evidenceManifest.js";
import type { RawArticle } from "./types.js";

type Fixture = {
  evidence: RawArticle[];
  provenance: NonNullable<BuildEvidenceManifestOptions["provenance"]>;
  valid_quote: NonNullable<BuildEvidenceManifestOptions["quote_bindings"]>[number];
  wrong_document_quote: NonNullable<BuildEvidenceManifestOptions["quote_bindings"]>[number];
  import: ExplicitEvidenceImport;
};

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await fs.readFile(path.resolve(root, "../tests/fixtures/stage-c/evidence-manifest.json"), "utf8")) as Fixture;

const result = buildEvidenceManifest(fixture.evidence, {
  provenance: fixture.provenance,
  quote_bindings: [fixture.valid_quote, fixture.wrong_document_quote],
  imports: [fixture.import]
});

assert.deepEqual(result.manifest.evidence_bindings.map((item) => item.evidence_ref), ["E1", "E2", "E3"]);
assert.equal(result.manifest.evidence_bindings[0]?.source_index, 0, "E1は実入力の先頭へbindする");
assert.equal(result.manifest.evidence_bindings[1]?.source_index, 1, "E2は実入力の2件目へbindする");
assert.equal(result.manifest.evidence_bindings[2]?.status, "explicit_legacy_import", "明示mapだけをlegacy importできる");
assert.equal(result.manifest.evidence_bindings[2]?.imported_claim_ref, "C3");
assert.equal(result.manifest.evidence_bindings[2]?.validation_origin, "stored_review_supplement");
assert.equal(result.manifest.documents[2]?.integrity.classification, "editorial_media", "importからprimaryを捏造せず保存ledgerのqualityを継承する");
assert.equal(result.manifest.documents[2]?.integrity.reason, "saved_operator_reviewed_quality");
assert.deepEqual(result.manifest.support_spans.map((item) => `${item.claim_ref}/${item.evidence_ref}`), ["C3/E3", "C1/E1"], "検証済み引用と明示importだけをsupport spanに残す");
assert.equal(result.manifest.support_spans.every((item) => /^[a-f0-9]{64}$/u.test(item.span_sha256)), true);
assert.equal(result.manifest.documents[0]?.normalized_url, "https://example.com/root", "query/hashを保存しない");
assert.equal(result.manifest.documents[0]?.fetched_at, null, "未知の取得時点を現在時刻で埋めない");
assert.equal(result.diagnostics.some((item) => item.code === "fetched_at_unknown" && item.evidence_ref === "E1"), true);
assert.equal(result.diagnostics.some((item) => item.code === "body_not_full" && item.evidence_ref === "E2"), true, "候補key_pointsを全文扱いしない");
assert.equal(result.diagnostics.some((item) => item.code === "quote_not_in_referenced_document" && item.claim_ref === "C2"), true, "別Eにだけある引用を拒否する");
assert.equal(result.diagnostics.some((item) => item.code === "quote_not_in_referenced_document" && item.claim_ref === "C1"), false);

const changedMetadata = structuredClone(fixture.evidence);
changedMetadata[0]!.title = "表示名だけ変更";
changedMetadata[0]!.sourceName = "別表示名";
const stable = buildEvidenceManifest(changedMetadata, { provenance: fixture.provenance });
assert.equal(stable.manifest.documents[0]?.document_id, result.manifest.documents[0]?.document_id, "document_idはURLと本文hashだけで安定する");

const sameVersionTwice = buildEvidenceManifest([fixture.evidence[0]!, { ...fixture.evidence[0]!, sourceName: "転載表示" }], {
  provenance: [{ fetched_at: null }, { fetched_at: null }]
});
assert.equal(sameVersionTwice.manifest.documents.length, 1, "同一URL・同一本文versionは同じdocumentを再利用する");
assert.deepEqual(sameVersionTwice.manifest.evidence_bindings.map((item) => item.evidence_ref), ["E1", "E2"]);
const updatedBody = buildEvidenceManifest([fixture.evidence[0]!, { ...fixture.evidence[0]!, rawContent: `${fixture.evidence[0]!.rawContent} 改定。` }], {
  provenance: [{ fetched_at: null }, { fetched_at: null }]
});
assert.equal(updatedBody.manifest.documents.length, 2, "同一URLでも本文更新は別document versionにする");
assert.notEqual(updatedBody.manifest.documents[0]?.document_id, updatedBody.manifest.documents[1]?.document_id);

assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, supplement: { ...fixture.import.supplement, evidence_ref: "E2" } }] }),
  (error) => error instanceof EvidenceManifestConflictError && error.diagnostic.code === "evidence_ref_collision"
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, supplement: { ...fixture.import.supplement, evidence_ref: "E4" } }] }),
  (error) => error instanceof EvidenceManifestConflictError && error.diagnostic.code === "evidence_ref_not_append_only"
);

const missingMiddle = structuredClone(fixture.evidence);
missingMiddle.splice(1, 0, { ...fixture.evidence[1]!, url: "https://example.net/missing", rawContent: undefined, excerpt: undefined });
const shiftedImport = {
  ...fixture.import,
  supplement: { ...fixture.import.supplement, evidence_ref: "E4" },
  ledger: {
    ...fixture.import.ledger,
    claims: fixture.import.ledger.claims.map((claim) => ({ ...claim, evidence_refs: ["E4"] })),
    evidence_roles: { E4: "related_angle" as const },
    evidence_quality: fixture.import.ledger.evidence_quality?.map((quality) => ({ ...quality, evidence_ref: "E4" }))
  }
};
const missingResult = buildEvidenceManifest(missingMiddle, {
  provenance: [fixture.provenance[0]!, fixture.provenance[1]!, fixture.provenance[1]!],
  imports: [shiftedImport, {
    ...shiftedImport,
    supplement: { ...shiftedImport.supplement, evidence_ref: "E5", claim_ref: "C4", source_url: "https://agency.example.gov/context-2" },
    ledger: {
      ...shiftedImport.ledger,
      claims: shiftedImport.ledger.claims.map((claim) => ({ ...claim, id: "C4", evidence_refs: ["E5"] })),
      evidence_roles: { E5: "related_angle" },
      evidence_quality: shiftedImport.ledger.evidence_quality?.map((quality) => ({ ...quality, evidence_ref: "E5" }))
    }
  }]
});
assert.deepEqual(missingResult.manifest.evidence_bindings.map((item) => item.evidence_ref), ["E1", "E2", "E3", "E4", "E5"]);
assert.equal(missingResult.manifest.evidence_bindings[1]?.status, "unresolved_input", "本文欠損でもE2位置を予約する");
assert.equal(missingResult.manifest.evidence_bindings[1]?.document_id, null);

const invalidFirst = buildEvidenceManifest([{ ...fixture.evidence[0]!, url: "not-a-url" }, fixture.evidence[1]!], {
  provenance: fixture.provenance,
  imports: [fixture.import]
});
assert.deepEqual(invalidFirst.manifest.evidence_bindings.map((item) => item.evidence_ref), ["E1", "E2", "E3"]);
assert.equal(invalidFirst.manifest.evidence_bindings[0]?.status, "unresolved_input", "不正URLの先頭E1も予約する");

assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, supplement: { ...fixture.import.supplement, claim_ref: "not-a-claim" } }] }),
  (error) => error instanceof EvidenceManifestConflictError && error.diagnostic.code === "evidence_ref_invalid"
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, ledger: { ...fixture.import.ledger, evidence_quality: undefined } }] }),
  (error) => error instanceof EvidenceManifestConflictError && /quality/u.test(error.message)
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, ledger: { ...fixture.import.ledger, evidence_roles: { E3: "root_corroboration" } } }] }),
  (error) => error instanceof EvidenceManifestConflictError && /related_angle/u.test(error.message)
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, ledger: { ...fixture.import.ledger, claims: fixture.import.ledger.claims.map((claim) => ({ ...claim, quote_zh: "別引用" })) } }] }),
  (error) => error instanceof EvidenceManifestConflictError && /引用/u.test(error.message)
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, supplement: { ...fixture.import.supplement, reviewed_by: "" } }] }),
  (error) => error instanceof EvidenceManifestConflictError && /確認来歴/u.test(error.message)
);
assert.throws(
  () => buildEvidenceManifest(fixture.evidence, { provenance: fixture.provenance, imports: [{ ...fixture.import, supplement: { ...fixture.import.supplement, body_sha256: "not-a-hash" } }] }),
  (error) => error instanceof EvidenceManifestConflictError && /body_sha256/u.test(error.message)
);

const unknownRef = buildEvidenceManifest(fixture.evidence, {
  provenance: fixture.provenance,
  quote_bindings: [{ claim_ref: "C9", evidence_ref: "E9", quote: "存在しない" }]
});
assert.equal(unknownRef.diagnostics.some((item) => item.code === "quote_ref_unknown" && item.claim_ref === "C9"), true);

console.log("EvidenceManifest v1: input binding, append-only imports, exact-document quote checks passed");
