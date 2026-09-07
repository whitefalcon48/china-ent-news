import { createHash } from "node:crypto";
import { assessExtractionQuality, type DocumentExtractionQuality } from "./documentSnapshot.js";
import { assessEvidenceIntegrity, type EvidenceIntegrityDiagnostic } from "./sourceIntegrity.js";
import type { EvidenceRole, FactLedger, RawArticle, ReviewEvidenceSupplement } from "../types.js";
import type {
  EvidenceBinding,
  EvidenceDocument,
  EvidenceExtractionQuality,
  EvidenceManifest,
  EvidenceManifestDiagnostic,
  EvidencePurpose,
  EvidenceStorageState,
  EvidenceSupportSpan
} from "../quality/types.js";

export type EvidenceInputProvenance = {
  requested_url?: string;
  final_url?: string;
  fetched_at?: string | null;
  extraction_quality?: DocumentExtractionQuality;
  role?: EvidenceRole;
  purpose?: EvidencePurpose;
  storage_state?: EvidenceStorageState;
  evidence_ref?: string;
};

export type EvidenceQuoteBinding = {
  claim_ref?: string;
  evidence_ref: string;
  quote: string;
  subject_quote?: string;
  document_id?: string;
};

export type ExplicitEvidenceImport = {
  validation_origin: "stored_review_supplement";
  supplement: ReviewEvidenceSupplement;
  ledger: FactLedger;
};

export type BuildEvidenceManifestOptions = {
  provenance?: EvidenceInputProvenance[];
  quote_bindings?: EvidenceQuoteBinding[];
  imports?: ExplicitEvidenceImport[];
};

export type EvidenceManifestBuildResult = {
  manifest: EvidenceManifest;
  diagnostics: EvidenceManifestDiagnostic[];
};

export class EvidenceManifestConflictError extends Error {
  readonly diagnostic: EvidenceManifestDiagnostic;

  constructor(diagnostic: EvidenceManifestDiagnostic) {
    super(diagnostic.message);
    this.name = "EvidenceManifestConflictError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Builds provenance only from the exact evidence array supplied to generation.
 * It performs no I/O and deliberately does not retain full source bodies.
 */
export function buildEvidenceManifest(
  evidence: RawArticle[],
  options: BuildEvidenceManifestOptions = {}
): EvidenceManifestBuildResult {
  const diagnostics: EvidenceManifestDiagnostic[] = [];
  const documents = new Map<string, EvidenceDocument>();
  const bodies = new Map<string, string>();
  const bindings: EvidenceBinding[] = [];
  const supportSpans: EvidenceSupportSpan[] = [];
  const integrity = assessEvidenceIntegrity(evidence);

  evidence.forEach((article, sourceIndex) => {
    const provenance = options.provenance?.[sourceIndex] ?? {};
    const expectedRef = `E${sourceIndex + 1}`;
    if (provenance.evidence_ref && provenance.evidence_ref !== expectedRef) {
      throw conflict("evidence_ref_collision", `入力順${sourceIndex + 1}は${expectedRef}に固定され、${provenance.evidence_ref}へ付け替えできません`, provenance.evidence_ref);
    }
    const requestedUrl = normalizeEvidenceUrl(provenance.requested_url ?? article.url);
    const finalUrl = normalizeEvidenceUrl(provenance.final_url ?? article.url);
    if (!requestedUrl || !finalUrl) {
      diagnostics.push(errorDiagnostic("invalid_url", "evidence URLを正規化できません", expectedRef));
      bindings.push(unresolvedBinding(expectedRef, sourceIndex, provenance, article));
      return;
    }
    const body = article.rawContent ?? article.excerpt ?? "";
    if (!body) diagnostics.push(errorDiagnostic("body_missing", "evidence本文がなくdocument_idを作成できません", expectedRef));
    const storageState = provenance.storage_state ?? (article.rawContent ? "raw_content" : article.excerpt ? "excerpt_only" : "missing");
    if (storageState !== "raw_content") {
      diagnostics.push(warningDiagnostic("body_not_full", `保存状態は${storageState}で、全文取得済みとは扱いません`, expectedRef));
    }
    if (!body) {
      bindings.push(unresolvedBinding(expectedRef, sourceIndex, provenance, article));
      return;
    }
    const bodyHash = sha256(body);
    const documentId = createDocumentId(finalUrl, bodyHash);
    const fetchedAt = normalizeOptionalTimestamp(provenance.fetched_at);
    if (!fetchedAt) diagnostics.push(warningDiagnostic("fetched_at_unknown", "取得時点が不明なためnullとして保持します", expectedRef, documentId));
    const publishedDate = article.publishedDate || article.publishedAt || null;
    if (!publishedDate) diagnostics.push(warningDiagnostic("published_date_unknown", "公開日が不明です", expectedRef, documentId));
    const document = makeDocument({
      article,
      integrity: integrity[sourceIndex]!,
      requestedUrl,
      finalUrl,
      fetchedAt,
      publishedDate,
      body,
      bodyHash,
      documentId,
      storageState,
      providedQuality: provenance.extraction_quality
    });
    documents.set(documentId, documents.get(documentId) ?? document);
    bodies.set(documentId, body);
    bindings.push({
      evidence_ref: expectedRef,
      document_id: documentId,
      source_index: sourceIndex,
      role: provenance.role ?? article.evidenceRole ?? "root_corroboration",
      purpose: provenance.purpose ?? "generation",
      status: "bound",
      validation_origin: "current_input_exact_body"
    });
  });

  for (const imported of options.imports ?? []) {
    appendExplicitImport(documents, bindings, supportSpans, imported, diagnostics);
  }

  validateQuotes(bindings, bodies, options.quote_bindings ?? [], supportSpans, diagnostics);
  return { manifest: { version: 1, documents: [...documents.values()], evidence_bindings: bindings, support_spans: supportSpans }, diagnostics };
}

export function createDocumentId(normalizedUrl: string, bodySha256: string) {
  return `doc-${sha256(`${normalizedUrl}\u0000${bodySha256}`).slice(0, 24)}`;
}

export function normalizeEvidenceUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function appendExplicitImport(
  documents: Map<string, EvidenceDocument>,
  bindings: EvidenceBinding[],
  supportSpans: EvidenceSupportSpan[],
  imported: ExplicitEvidenceImport,
  diagnostics: EvidenceManifestDiagnostic[]
) {
  const supplement = imported.supplement;
  if (imported.validation_origin !== "stored_review_supplement") {
    throw conflict("evidence_ref_invalid", "legacy importのvalidation_originが不正です");
  }
  if (!/^E[1-9]\d*$/u.test(supplement.evidence_ref)) {
    throw conflict("evidence_ref_invalid", `明示evidence_refが不正です: ${supplement.evidence_ref}`, supplement.evidence_ref);
  }
  if (!/^C[1-9]\d*$/u.test(supplement.claim_ref)) {
    throw conflict("evidence_ref_invalid", `明示claim_refが不正です: ${supplement.claim_ref}`, supplement.evidence_ref);
  }
  if (supplement.verification !== "operator_reviewed_exact_quotes" || !supplement.reviewed_by.trim()) {
    throw conflict("support_span_invalid", "保存済み工程Bの確認来歴がありません", supplement.evidence_ref);
  }
  if (bindings.some((binding) => binding.evidence_ref === supplement.evidence_ref)) {
    throw conflict("evidence_ref_collision", `${supplement.evidence_ref}は既に別の入力へbindされています`, supplement.evidence_ref);
  }
  const nextRef = `E${bindings.length + 1}`;
  if (supplement.evidence_ref !== nextRef) {
    throw conflict("evidence_ref_not_append_only", `明示根拠は${nextRef}として末尾追加する必要があります`, supplement.evidence_ref);
  }
  const claim = imported.ledger.claims.find((item) => item.id === supplement.claim_ref);
  const quality = imported.ledger.evidence_quality?.find((item) => item.evidence_ref === supplement.evidence_ref);
  if (!claim || !claim.evidence_refs.includes(supplement.evidence_ref) || claim.scope !== "related_angle") {
    throw conflict("evidence_ref_collision", "保存ledgerのclaimとC/E対応が一致しません", supplement.evidence_ref);
  }
  if (
    !claim.quote_zh ||
    normalizeWhitespace(claim.quote_zh) !== normalizeWhitespace(supplement.source_quote) ||
    (claim.source_name ?? "") !== supplement.source_name
  ) {
    throw conflict("quote_document_mismatch", "保存ledgerの引用・出典名とsupplementが一致しません", supplement.evidence_ref);
  }
  if (imported.ledger.evidence_roles?.[supplement.evidence_ref] !== "related_angle") {
    throw conflict("evidence_ref_collision", "保存ledgerのevidence roleがrelated_angleではありません", supplement.evidence_ref);
  }
  if (!quality) throw conflict("evidence_ref_collision", "保存ledgerのevidence qualityがありません", supplement.evidence_ref);
  const normalizedUrl = normalizeEvidenceUrl(supplement.source_url);
  if (!normalizedUrl) throw conflict("invalid_url", "明示根拠URLを正規化できません", supplement.evidence_ref);
  if (!/^[a-f0-9]{64}$/u.test(supplement.body_sha256)) {
    throw conflict("body_missing", "明示根拠のbody_sha256が不正です", supplement.evidence_ref);
  }
  if (!validSpanText(supplement.source_quote) || !validSpanText(supplement.subject_quote)) {
    throw conflict("support_span_invalid", "明示根拠の引用は1〜400字である必要があります", supplement.evidence_ref);
  }
  const documentId = createDocumentId(normalizedUrl, supplement.body_sha256);
  const fetchedAt = normalizeOptionalTimestamp(supplement.fetched_at);
  if (!fetchedAt) diagnostics.push(warningDiagnostic("fetched_at_unknown", "明示根拠の取得時点が不明なためnullとして保持します", supplement.evidence_ref, documentId));
  if (!supplement.source_published_date) diagnostics.push(warningDiagnostic("published_date_unknown", "明示根拠の公開日が不明です", supplement.evidence_ref, documentId));
  documents.set(documentId, documents.get(documentId) ?? {
    document_id: documentId,
    normalized_url: normalizedUrl,
    requested_url: normalizedUrl,
    final_url: normalizedUrl,
    source_name: supplement.source_name,
    title: supplement.source_title,
    published_date: supplement.source_published_date || null,
    fetched_at: fetchedAt,
    body_sha256: supplement.body_sha256,
    extraction_quality: unknownQuality(),
    integrity: {
      classification: quality.classification,
      usable_for_verified_facts: quality.usable_for_verified_facts,
      reason: quality.reason
    },
    storage_state: "review_supplement_excerpt"
  });
  bindings.push({
    evidence_ref: supplement.evidence_ref,
    document_id: documentId,
    source_index: null,
    role: "related_angle",
    purpose: "reader_context",
    status: "explicit_legacy_import",
    validation_origin: "stored_review_supplement",
    imported_claim_ref: supplement.claim_ref
  });
  supportSpans.push(makeSupportSpan(
    supplement.evidence_ref,
    documentId,
    supplement.source_quote,
    supplement.subject_quote,
    "stored_review_supplement",
    supplement.claim_ref
  ));
}

function validateQuotes(
  bindings: EvidenceBinding[],
  bodies: Map<string, string>,
  quotes: EvidenceQuoteBinding[],
  supportSpans: EvidenceSupportSpan[],
  diagnostics: EvidenceManifestDiagnostic[]
) {
  for (const item of quotes) {
    if (!validSpanText(item.quote) || (item.subject_quote !== undefined && !validSpanText(item.subject_quote))) {
      diagnostics.push(errorDiagnostic("support_span_invalid", "引用は1〜400字である必要があります", item.evidence_ref, undefined, item.claim_ref));
      continue;
    }
    const binding = bindings.find((candidate) => candidate.evidence_ref === item.evidence_ref);
    if (!binding) {
      diagnostics.push(errorDiagnostic("quote_ref_unknown", `${item.evidence_ref}の参照先がありません`, item.evidence_ref, undefined, item.claim_ref));
      continue;
    }
    if (!binding.document_id) {
      diagnostics.push(errorDiagnostic("quote_document_mismatch", "evidence_refは欠損入力位置に予約され、参照文書がありません", item.evidence_ref, undefined, item.claim_ref));
      continue;
    }
    if (item.document_id && item.document_id !== binding.document_id) {
      diagnostics.push(errorDiagnostic("quote_document_mismatch", "quoteのdocument_idとevidence_refの参照先が一致しません", item.evidence_ref, binding.document_id, item.claim_ref));
      continue;
    }
    const body = bodies.get(binding.document_id);
    const quoteMatches = Boolean(body) && normalizeWhitespace(body!).includes(normalizeWhitespace(item.quote));
    const subjectMatches = !item.subject_quote || (Boolean(body) && normalizeWhitespace(body!).includes(normalizeWhitespace(item.subject_quote)));
    if (!quoteMatches || !subjectMatches) {
      diagnostics.push(errorDiagnostic("quote_not_in_referenced_document", "引用は指定された文書内に存在しません", item.evidence_ref, binding.document_id, item.claim_ref));
      continue;
    }
    supportSpans.push(makeSupportSpan(item.evidence_ref, binding.document_id, item.quote, item.subject_quote ?? "", "current_input_exact_body", item.claim_ref));
  }
}

function makeSupportSpan(
  evidenceRef: string,
  documentId: string,
  quote: string,
  subjectQuote: string,
  validationOrigin: EvidenceSupportSpan["validation_origin"],
  claimRef?: string
): EvidenceSupportSpan {
  return {
    evidence_ref: evidenceRef,
    ...(claimRef ? { claim_ref: claimRef } : {}),
    document_id: documentId,
    quote,
    subject_quote: subjectQuote,
    span_sha256: sha256(`${documentId}\u0000${quote}\u0000${subjectQuote}`),
    validation_origin: validationOrigin
  };
}

function unresolvedBinding(
  evidenceRef: string,
  sourceIndex: number,
  provenance: EvidenceInputProvenance,
  article: RawArticle
): EvidenceBinding {
  return {
    evidence_ref: evidenceRef,
    document_id: null,
    source_index: sourceIndex,
    role: provenance.role ?? article.evidenceRole ?? "root_corroboration",
    purpose: provenance.purpose ?? "generation",
    status: "unresolved_input",
    validation_origin: "legacy_unresolved"
  };
}

function makeDocument(input: {
  article: RawArticle;
  integrity: EvidenceIntegrityDiagnostic;
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string | null;
  publishedDate: string | null;
  body: string;
  bodyHash: string;
  documentId: string;
  storageState: EvidenceStorageState;
  providedQuality?: DocumentExtractionQuality;
}): EvidenceDocument {
  return {
    document_id: input.documentId,
    normalized_url: input.finalUrl,
    requested_url: input.requestedUrl,
    final_url: input.finalUrl,
    source_name: input.article.sourceName,
    title: input.article.title,
    published_date: input.publishedDate,
    fetched_at: input.fetchedAt,
    body_sha256: input.bodyHash,
    extraction_quality: toQuality(input.body, input.providedQuality),
    integrity: {
      classification: input.integrity.classification,
      usable_for_verified_facts: input.integrity.usable_for_verified_facts,
      reason: input.integrity.reason
    },
    storage_state: input.storageState
  };
}

function toQuality(body: string, provided?: DocumentExtractionQuality): EvidenceExtractionQuality {
  const quality = provided ?? assessExtractionQuality(body);
  return {
    status: quality.status,
    source: provided ? "provided" : "measured",
    raw_chars: quality.raw_chars,
    meaningful_chars: quality.meaningful_chars,
    sentence_count: quality.sentence_count,
    boilerplate_ratio: quality.boilerplate_ratio,
    factual_anchor_count: quality.factual_anchor_count
  };
}

function unknownQuality(): EvidenceExtractionQuality {
  return {
    status: "unknown",
    source: "unknown",
    raw_chars: null,
    meaningful_chars: null,
    sentence_count: null,
    boilerplate_ratio: null,
    factual_anchor_count: null
  };
}

function normalizeOptionalTimestamp(value: string | null | undefined) {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function validSpanText(value: string) {
  const length = [...value.trim()].length;
  return length > 0 && length <= 400;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function conflict(code: EvidenceManifestDiagnostic["code"], message: string, evidenceRef?: string) {
  return new EvidenceManifestConflictError(errorDiagnostic(code, message, evidenceRef));
}

function warningDiagnostic(
  code: EvidenceManifestDiagnostic["code"],
  message: string,
  evidenceRef?: string,
  documentId?: string
): EvidenceManifestDiagnostic {
  return { severity: "warning", code, message, evidence_ref: evidenceRef, document_id: documentId };
}

function errorDiagnostic(
  code: EvidenceManifestDiagnostic["code"],
  message: string,
  evidenceRef?: string,
  documentId?: string,
  claimRef?: string
): EvidenceManifestDiagnostic {
  return { severity: "error", code, message, evidence_ref: evidenceRef, document_id: documentId, claim_ref: claimRef };
}
