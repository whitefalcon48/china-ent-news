import type { EvidenceIntegrityClass } from "../evidence/sourceIntegrity.js";
import type { EvidenceRole, SummarizedArticle } from "../types.js";

export type EvidencePurpose = "generation" | "reader_context";

export type EvidenceStorageState =
  | "raw_content"
  | "excerpt_only"
  | "candidate_key_points"
  | "title_only"
  | "review_supplement_excerpt"
  | "missing";

export type EvidenceBindingStatus = "bound" | "explicit_legacy_import" | "legacy_unresolved" | "unresolved_input";

export type EvidenceValidationOrigin = "current_input_exact_body" | "stored_review_supplement" | "legacy_unresolved";

export type EvidenceExtractionQuality = {
  status: "usable" | "limited" | "unusable" | "unknown";
  source: "provided" | "measured" | "unknown";
  raw_chars: number | null;
  meaningful_chars: number | null;
  sentence_count: number | null;
  boilerplate_ratio: number | null;
  factual_anchor_count: number | null;
};

export type EvidenceDocument = {
  document_id: string;
  normalized_url: string;
  requested_url: string;
  final_url: string;
  source_name: string;
  title: string;
  published_date: string | null;
  fetched_at: string | null;
  body_sha256: string;
  extraction_quality: EvidenceExtractionQuality;
  integrity: {
    classification: EvidenceIntegrityClass;
    usable_for_verified_facts: boolean;
    reason: string;
  };
  storage_state: EvidenceStorageState;
};

export type EvidenceBinding = {
  evidence_ref: string;
  document_id: string | null;
  source_index: number | null;
  role: EvidenceRole;
  purpose: EvidencePurpose;
  status: EvidenceBindingStatus;
  validation_origin: EvidenceValidationOrigin;
  imported_claim_ref?: string;
};

export type EvidenceSupportSpan = {
  evidence_ref: string;
  claim_ref?: string;
  document_id: string;
  quote: string;
  subject_quote: string;
  span_sha256: string;
  validation_origin: Exclude<EvidenceValidationOrigin, "legacy_unresolved">;
};

export type EvidenceManifest = {
  version: 1;
  documents: EvidenceDocument[];
  evidence_bindings: EvidenceBinding[];
  support_spans: EvidenceSupportSpan[];
};

export type EvidenceManifestDiagnosticCode =
  | "invalid_url"
  | "body_missing"
  | "body_not_full"
  | "fetched_at_unknown"
  | "published_date_unknown"
  | "evidence_ref_invalid"
  | "evidence_ref_collision"
  | "evidence_ref_not_append_only"
  | "quote_ref_unknown"
  | "quote_document_mismatch"
  | "quote_not_in_referenced_document"
  | "support_span_invalid";

export type EvidenceManifestDiagnostic = {
  severity: "warning" | "error";
  code: EvidenceManifestDiagnosticCode;
  message: string;
  evidence_ref?: string;
  claim_ref?: string;
  document_id?: string;
};

export type EvaluationVersionKind = "draft" | "current" | "published";

export type EvaluationVersionSnapshot = {
  kind: EvaluationVersionKind;
  available: boolean;
  version_number: number | null;
  summary_hash: string | null;
  source: "revision_store" | "current_article" | "legacy_current_snapshot" | "unavailable";
  separate_snapshot: boolean;
  summary?: SummarizedArticle;
};

export type EvaluationEvidenceRecord = {
  normalized_url: string;
  source_name: string;
  title: string;
  role: EvidenceRole;
  purpose: EvidencePurpose;
  storage_state: EvidenceStorageState;
  raw_body_available: boolean;
  body_sha256: string | null;
  fetched_at: string | null;
  evidence_ref: string | null;
  claim_ref: string | null;
  binding_status: EvidenceBindingStatus;
};

export type EvaluationFileRecord = {
  kind: "articles" | "review" | "ledger" | "revisions";
  path: string;
  exists: boolean;
  git_blob_sha: string | null;
};

export type QualityEvaluationArticle = {
  date: string;
  index: number;
  topic_key: string;
  article_id: string | null;
  title: string;
  repository_sha: string | null;
  input_files: EvaluationFileRecord[];
  versions: {
    draft: EvaluationVersionSnapshot;
    current: EvaluationVersionSnapshot;
    published: EvaluationVersionSnapshot;
  };
  ledger_generation: {
    status: "generated" | "fallback" | "missing";
    ledger_used: boolean;
    failure_reason: string | null;
  };
  evidence: EvaluationEvidenceRecord[];
  known_claim_evidence_bindings: Array<{
    claim_ref: string;
    evidence_ref: string;
    normalized_url: string;
    source: "review_supplement";
  }>;
  unresolved_claim_evidence_pairs: number;
  diagnostics: Array<{
    severity: "warning" | "error";
    code:
      | "article_index_mismatch"
      | "article_id_mismatch"
      | "topic_identity_mismatch"
      | "review_store_current_version_mismatch"
      | "current_summary_revision_mismatch"
      | "published_snapshot_unverified";
    message: string;
  }>;
  comparable: boolean;
  missing_reasons: string[];
};

export type QualityEvaluationManifest = {
  version: 1;
  scope: {
    start_date: string;
    end_date: string;
    expected_article_count: number;
  };
  repository_sha: string | null;
  dates: Array<{
    date: string;
    article_count: number;
    zero_article_day: boolean;
    input_files: EvaluationFileRecord[];
  }>;
  articles: QualityEvaluationArticle[];
  totals: {
    dates: number;
    articles: number;
    zero_article_days: number;
    ledger_generated: number;
    ledger_fallback: number;
    raw_body_available: number;
    raw_body_missing: number;
    known_claim_evidence_bindings: number;
    unresolved_claim_evidence_pairs: number;
    comparable_articles: number;
  };
};

export type ReaderContextKind = "organization" | "institution" | "industry_concept";
export type ReaderContextNecessity = "required" | "optional" | "not_needed";

export type ReaderContextSourceOccurrence = {
  evidence_ref: string;
  document_id: string;
  span: string;
};

export type ReaderContextSupportCandidate = {
  support_id: string;
  support_kind: "claim" | "term";
  definition_ja: string;
  evidence_ref: string;
  document_id: string;
  quote: string;
  subject_quote: string;
  claim_ref?: string;
  applicable_at?: string | null;
  fetched_at?: string | null;
};

export type ReaderContextRequest = {
  concept_id: string;
  term: string;
  aliases: string[];
  kind: ReaderContextKind;
  source_occurrences: ReaderContextSourceOccurrence[];
  necessity: ReaderContextNecessity;
  reason_ja: string;
  missing_understanding: string;
  support_candidates: ReaderContextSupportCandidate[];
};

export type ReaderContextSemanticReviewInput = {
  request: ReaderContextRequest;
  support: ReaderContextSupportCandidate;
  first_occurrence: {
    field: "lead" | "what_happened" | "reaction_view" | "why_it_matters" | "japan_context_note";
    anchor: string;
    start: number;
    end: number;
  };
  source: {
    source_name: string;
    url: string;
    role: EvidenceRole;
    quote: string;
    subject_quote: string;
    source_published_at: string | null;
    fetched_at: string | null;
    applicable_at: null;
  };
  summary: SummarizedArticle;
};

export type ReaderContextSemanticReviewResult = {
  status: "pass" | "revise" | "hold";
  definition_ja?: string;
  already_explained?: boolean;
  existing_span?: string;
  reason_codes: string[];
};

export type ReaderContextPatchProposal = {
  concept_id: string;
  summary_hash: string;
  field: "lead" | "what_happened" | "reaction_view" | "why_it_matters" | "japan_context_note";
  anchor: string;
  anchor_start: number;
  position: "after_first_occurrence";
  insert_text: string;
  claim_refs: string[];
  evidence_refs: string[];
  document_ids: string[];
  source_urls: string[];
  scope: "root_event" | "related_angle";
};

export type ReaderContextResolution = {
  request_id: string;
  status: "not_needed" | "resolved" | "held";
  origin: "input" | "reused" | "searched";
  necessity: ReaderContextNecessity;
  support_status: "not_checked" | "support_ready" | "needs_research" | "invalid";
  semantic_review_status: "not_run" | "pass" | "revise" | "hold" | "unavailable";
  outcome: "not_needed" | "patch_proposed" | "merged" | "already_explained" | "needs_research" | "revise" | "hold";
  definition_ja: string;
  claim_refs: string[];
  evidence_refs: string[];
  document_ids: string[];
  support_spans: Array<{
    evidence_ref: string;
    document_id: string;
    quote: string;
    subject_quote: string;
  }>;
  applicable_at: string | null;
  source_published_at: string | null;
  fetched_at: string | null;
  reason_codes: string[];
  patch?: ReaderContextPatchProposal;
};

export type ReaderContextPlan = {
  summary_hash: string;
  resolutions: ReaderContextResolution[];
  patches: ReaderContextPatchProposal[];
  needs_research: string[];
  holds: string[];
  diagnostics: Array<{
    concept_id?: string;
    code: string;
    message: string;
  }>;
};
