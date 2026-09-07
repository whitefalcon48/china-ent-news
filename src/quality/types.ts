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

export type EvidenceBindingStatus = "bound" | "explicit_legacy_import" | "legacy_unresolved";

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
  document_id: string;
  source_index: number | null;
  role: EvidenceRole;
  purpose: EvidencePurpose;
  status: EvidenceBindingStatus;
  imported_claim_ref?: string;
};

export type EvidenceSupportSpan = {
  evidence_ref: string;
  claim_ref?: string;
  document_id: string;
  quote: string;
  subject_quote: string;
  span_sha256: string;
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
