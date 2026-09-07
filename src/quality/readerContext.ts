import { createHash } from "node:crypto";
import type { FactLedger, RawArticle, SummarizedArticle } from "../types.js";
import type {
  EvidenceManifest,
  ReaderContextPatchProposal,
  ReaderContextPlan,
  ReaderContextRequest,
  ReaderContextResolution,
  ReaderContextSemanticReviewInput,
  ReaderContextSemanticReviewResult,
  ReaderContextSupportCandidate
} from "./types.js";

const MAX_REQUESTS = 8;
const SUMMARY_FIELDS = ["lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note"] as const;

export type ReaderContextSemanticReviewer = (
  input: ReaderContextSemanticReviewInput
) => Promise<ReaderContextSemanticReviewResult>;

export type BuildReaderContextPlanInput = {
  evidence: RawArticle[];
  manifest: EvidenceManifest;
  ledger: FactLedger;
  requests: ReaderContextRequest[];
  summary: SummarizedArticle;
  review_semantics: ReaderContextSemanticReviewer;
};

/**
 * Produces a side-effect-free plan. Candidate necessity and semantic support
 * are injected; this helper never substitutes regex classification, I/O, or an LLM.
 */
export async function buildReaderContextPlan(input: BuildReaderContextPlanInput): Promise<ReaderContextPlan> {
  const summaryHash = sha256(JSON.stringify(input.summary));
  const diagnostics: ReaderContextPlan["diagnostics"] = [];
  const resolutions: ReaderContextResolution[] = [];
  const ids = new Set<string>();

  if (input.requests.length > MAX_REQUESTS) {
    for (const request of input.requests) {
      diagnostics.push({ concept_id: request.concept_id, code: "too_many_context_requests", message: `候補は最大${MAX_REQUESTS}件です` });
      resolutions.push(holdResolution(request, "too_many_context_requests"));
    }
    return finalize(summaryHash, resolutions, diagnostics);
  }

  for (const request of input.requests) {
    const idError = validateRequestId(request.concept_id, ids);
    if (idError) {
      diagnostics.push({ concept_id: request.concept_id, code: idError, message: "concept_idが不正または重複しています" });
      resolutions.push(holdResolution(request, idError));
      continue;
    }
    ids.add(request.concept_id);

    const occurrenceError = validateOccurrences(request, input.manifest, input.evidence);
    if (occurrenceError) {
      diagnostics.push({ concept_id: request.concept_id, code: occurrenceError, message: "候補の出現spanをE/documentへbindできません" });
      resolutions.push(holdResolution(request, occurrenceError));
      continue;
    }

    if (request.necessity === "not_needed") {
      resolutions.push({
        request_id: request.concept_id,
        status: "not_needed",
        origin: "input",
        necessity: request.necessity,
        support_status: "not_checked",
        semantic_review_status: "not_run",
        outcome: "not_needed",
        definition_ja: "",
        claim_refs: [],
        evidence_refs: [],
        document_ids: [],
        support_spans: [],
        applicable_at: null,
        fetched_at: null,
        reason_codes: []
      });
      continue;
    }

    const support = selectSupport(request, input.manifest, input.ledger);
    if (!support.ready) {
      diagnostics.push({ concept_id: request.concept_id, code: support.reason, message: support.message });
      resolutions.push(support.invalid
        ? holdResolution(request, support.reason)
        : researchResolution(request, support.reason));
      continue;
    }

    const firstOccurrence = findFirstSummaryOccurrence(input.summary, request);
    if (!firstOccurrence) {
      diagnostics.push({ concept_id: request.concept_id, code: "concept_not_in_summary", message: "説明対象語が公表本文にありません" });
      resolutions.push(holdResolution(request, "concept_not_in_summary", support.candidate, "not_run", input.manifest));
      continue;
    }

    let review: ReaderContextSemanticReviewResult;
    try {
      const document = input.manifest.documents.find((item) => item.document_id === support.candidate.document_id)!;
      const binding = input.manifest.evidence_bindings.find((item) => item.evidence_ref === support.candidate.evidence_ref)!;
      review = await input.review_semantics({
        request: structuredClone(request),
        support: structuredClone(support.candidate),
        source: {
          source_name: document.source_name,
          url: document.final_url,
          role: binding.role,
          quote: support.candidate.quote,
          subject_quote: support.candidate.subject_quote
        },
        summary: structuredClone(input.summary)
      });
    } catch {
      diagnostics.push({ concept_id: request.concept_id, code: "semantic_review_unavailable", message: "意味審査を完了できません" });
      resolutions.push(holdResolution(request, "semantic_review_unavailable", support.candidate, "unavailable", input.manifest));
      continue;
    }

    if (!isSemanticReviewResult(review)) {
      diagnostics.push({ concept_id: request.concept_id, code: "semantic_review_invalid", message: "意味審査の返却schemaが不正です" });
      resolutions.push(holdResolution(request, "semantic_review_invalid", support.candidate, "hold", input.manifest));
      continue;
    }

    if (review.status === "hold") {
      resolutions.push(holdResolution(request, review.reason_codes[0] ?? "semantic_support_held", support.candidate, "hold", input.manifest));
      continue;
    }
    if (review.status === "revise") {
      resolutions.push({
        ...baseSupportedResolution(request, support.candidate, input.manifest),
        semantic_review_status: "revise",
        outcome: "revise",
        definition_ja: review.definition_ja ?? support.candidate.definition_ja,
        reason_codes: review.reason_codes.length ? review.reason_codes : ["semantic_wording_revision_required"]
      });
      continue;
    }

    const definition = (review.definition_ja ?? support.candidate.definition_ja).trim();
    if (!definition || [...definition].length > 100) {
      diagnostics.push({ concept_id: request.concept_id, code: "semantic_definition_invalid", message: "意味審査後の説明は1〜100字である必要があります" });
      resolutions.push(holdResolution(request, "semantic_definition_invalid", support.candidate, "hold", input.manifest));
      continue;
    }
    if (review.already_explained) {
      const existingSpan = review.existing_span?.trim() ?? "";
      if (!existingSpan || !summaryText(input.summary).includes(existingSpan)) {
        diagnostics.push({ concept_id: request.concept_id, code: "existing_explanation_span_mismatch", message: "説明済みとされたspanが本文にありません" });
        resolutions.push(holdResolution(request, "existing_explanation_span_mismatch", support.candidate, "hold", input.manifest));
        continue;
      }
      resolutions.push({
        ...baseSupportedResolution(request, support.candidate, input.manifest),
        status: "resolved",
        semantic_review_status: "pass",
        outcome: "already_explained",
        definition_ja: definition,
        reason_codes: review.reason_codes
      });
      continue;
    }

    const binding = input.manifest.evidence_bindings.find((item) => item.evidence_ref === support.candidate.evidence_ref)!;
    const document = input.manifest.documents.find((item) => item.document_id === support.candidate.document_id)!;
    const patch: ReaderContextPatchProposal = {
      concept_id: request.concept_id,
      summary_hash: summaryHash,
      field: firstOccurrence.field,
      anchor: firstOccurrence.anchor,
      position: "after_first_occurrence",
      insert_text: definition,
      claim_refs: support.candidate.claim_ref ? [support.candidate.claim_ref] : [],
      evidence_refs: [support.candidate.evidence_ref],
      document_ids: [support.candidate.document_id],
      source_urls: [document.final_url],
      scope: binding.role === "root_corroboration" ? "root_event" : "related_angle"
    };
    resolutions.push({
      ...baseSupportedResolution(request, support.candidate, input.manifest),
      status: "resolved",
      semantic_review_status: "pass",
      outcome: "patch_proposed",
      definition_ja: definition,
      reason_codes: review.reason_codes,
      patch
    });
  }

  return finalize(summaryHash, resolutions, diagnostics);
}

function selectSupport(
  request: ReaderContextRequest,
  manifest: EvidenceManifest,
  ledger: FactLedger
): { ready: true; candidate: ReaderContextSupportCandidate } | { ready: false; invalid: boolean; reason: string; message: string } {
  if (!request.support_candidates.length) {
    return { ready: false, invalid: false, reason: "context_support_missing", message: "入力内に説明supportがありません" };
  }
  const failures: string[] = [];
  for (const candidate of request.support_candidates) {
    const failure = validateSupportCandidate(request, candidate, manifest, ledger);
    if (!failure) return { ready: true, candidate };
    failures.push(failure);
  }
  const researchableReasons = new Set([
    "support_not_current_input",
    "support_document_unusable",
    "support_integrity_unusable",
    "support_claim_unusable"
  ]);
  const invalidFailure = failures.find((failure) => !researchableReasons.has(failure));
  const reason = invalidFailure ?? failures[0] ?? "context_support_missing";
  return {
    ready: false,
    invalid: Boolean(invalidFailure),
    reason,
    message: invalidFailure ? "supportのC/E/document対応が不正です" : "入力supportは現取得・利用可能な根拠ではありません"
  };
}

function validateSupportCandidate(
  request: ReaderContextRequest,
  candidate: ReaderContextSupportCandidate,
  manifest: EvidenceManifest,
  ledger: FactLedger
) {
  if (!candidate.support_id.trim() || !candidate.definition_ja.trim()) return "support_candidate_invalid";
  if (
    !candidate.quote.trim() ||
    !candidate.subject_quote.trim() ||
    [...candidate.quote].length > 400 ||
    [...candidate.subject_quote].length > 400
  ) return "support_span_invalid";
  const binding = manifest.evidence_bindings.find((item) => item.evidence_ref === candidate.evidence_ref);
  if (!binding) return "support_ref_mismatch";
  if (binding.status !== "bound" || binding.validation_origin !== "current_input_exact_body") return "support_not_current_input";
  if (binding.document_id !== candidate.document_id) return "support_ref_mismatch";
  const document = manifest.documents.find((item) => item.document_id === candidate.document_id);
  if (!document) return "support_ref_mismatch";
  if (candidate.fetched_at !== undefined && candidate.fetched_at !== document.fetched_at) return "support_fetched_at_mismatch";
  if (candidate.applicable_at !== undefined && candidate.applicable_at !== document.published_date) return "support_applicable_at_mismatch";
  if (document.storage_state !== "raw_content" || document.extraction_quality.status !== "usable") return "support_document_unusable";
  if (!document.integrity.usable_for_verified_facts) return "support_integrity_unusable";
  const span = manifest.support_spans.find((item) =>
    item.evidence_ref === candidate.evidence_ref &&
    item.document_id === candidate.document_id &&
    normalizeWhitespace(item.quote) === normalizeWhitespace(candidate.quote) &&
    normalizeWhitespace(item.subject_quote) === normalizeWhitespace(candidate.subject_quote) &&
    item.validation_origin === "current_input_exact_body"
  );
  if (!span) return "support_span_unverified";
  if (candidate.support_kind === "claim") {
    if (!candidate.claim_ref || !/^C[1-9]\d*$/u.test(candidate.claim_ref)) return "support_claim_invalid";
    const claim = ledger.claims.find((item) => item.id === candidate.claim_ref);
    if (!claim || !claim.evidence_refs.includes(candidate.evidence_ref)) return "support_claim_ref_mismatch";
    if (claim.type === "unsupported") return "support_claim_unusable";
    if (normalizeWhitespace(claim.quote_zh ?? "") !== normalizeWhitespace(candidate.quote)) return "support_claim_quote_mismatch";
    const expectedScope = binding.role === "root_corroboration" ? "root_event" : "related_angle";
    if (claim.scope !== expectedScope) return "support_claim_scope_mismatch";
  } else {
    const term = ledger.terms.find((item) => [request.term, ...request.aliases].includes(item.term));
    if (term) {
      if (!term.explain_evidence_refs?.includes(candidate.evidence_ref)) return "support_term_ref_mismatch";
      if (normalizeWhitespace(term.explain_quote_zh ?? "") !== normalizeWhitespace(candidate.quote)) return "support_term_quote_mismatch";
    }
  }
  return "";
}

function validateOccurrences(request: ReaderContextRequest, manifest: EvidenceManifest, evidence: RawArticle[]) {
  if (!request.term.trim() || !request.source_occurrences.length) return "source_occurrence_missing";
  for (const occurrence of request.source_occurrences) {
    if (!occurrence.span.trim() || [...occurrence.span].length > 400) return "source_occurrence_invalid";
    const binding = manifest.evidence_bindings.find((item) => item.evidence_ref === occurrence.evidence_ref);
    if (
      !binding ||
      binding.status !== "bound" ||
      binding.validation_origin !== "current_input_exact_body" ||
      binding.document_id !== occurrence.document_id ||
      binding.source_index === null ||
      binding.source_index === undefined
    ) {
      return "source_occurrence_ref_mismatch";
    }
    const body = evidence[binding.source_index]?.rawContent ?? "";
    if (!normalizeWhitespace(body).includes(normalizeWhitespace(occurrence.span))) return "source_occurrence_span_mismatch";
    if (![request.term, ...request.aliases].some((term) => term && occurrence.span.includes(term))) return "source_occurrence_term_mismatch";
  }
  return "";
}

function findFirstSummaryOccurrence(summary: SummarizedArticle, request: ReaderContextRequest) {
  const terms = [request.term, ...request.aliases].filter(Boolean);
  for (const field of SUMMARY_FIELDS) {
    const value = summary[field];
    let match: { anchor: string; index: number } | undefined;
    for (const term of terms) {
      const index = value.indexOf(term);
      if (index >= 0 && (!match || index < match.index)) match = { anchor: term, index };
    }
    if (match) return { field, anchor: match.anchor };
  }
  return null;
}

function validateRequestId(value: string, ids: Set<string>) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,63}$/u.test(value)) return "concept_id_invalid";
  return ids.has(value) ? "concept_id_duplicate" : "";
}

function isSemanticReviewResult(value: ReaderContextSemanticReviewResult) {
  return Boolean(
    value &&
    ["pass", "revise", "hold"].includes(value.status) &&
    Array.isArray(value.reason_codes) &&
    value.reason_codes.every((item) => typeof item === "string") &&
    (value.definition_ja === undefined || typeof value.definition_ja === "string") &&
    (value.existing_span === undefined || typeof value.existing_span === "string") &&
    (value.already_explained === undefined || typeof value.already_explained === "boolean")
  );
}

function baseSupportedResolution(
  request: ReaderContextRequest,
  support: ReaderContextSupportCandidate,
  manifest: EvidenceManifest
): ReaderContextResolution {
  const document = manifest.documents.find((item) => item.document_id === support.document_id);
  return {
    request_id: request.concept_id,
    status: "held",
    origin: "input",
    necessity: request.necessity,
    support_status: "support_ready",
    semantic_review_status: "not_run",
    outcome: "hold",
    definition_ja: support.definition_ja,
    claim_refs: support.claim_ref ? [support.claim_ref] : [],
    evidence_refs: [support.evidence_ref],
    document_ids: [support.document_id],
    support_spans: [{
      evidence_ref: support.evidence_ref,
      document_id: support.document_id,
      quote: support.quote,
      subject_quote: support.subject_quote
    }],
    applicable_at: document?.published_date ?? null,
    fetched_at: document?.fetched_at ?? null,
    reason_codes: []
  };
}

function researchResolution(request: ReaderContextRequest, reason: string): ReaderContextResolution {
  return {
    request_id: request.concept_id,
    status: "held",
    origin: reason === "support_not_current_input" ? "reused" : "input",
    necessity: request.necessity,
    support_status: "needs_research",
    semantic_review_status: "not_run",
    outcome: "needs_research",
    definition_ja: "",
    claim_refs: [],
    evidence_refs: [],
    document_ids: [],
    support_spans: [],
    applicable_at: null,
    fetched_at: null,
    reason_codes: [reason]
  };
}

function holdResolution(
  request: ReaderContextRequest,
  reason: string,
  support?: ReaderContextSupportCandidate,
  reviewStatus: ReaderContextResolution["semantic_review_status"] = "not_run",
  manifest?: EvidenceManifest
): ReaderContextResolution {
  const document = support && manifest?.documents.find((item) => item.document_id === support.document_id);
  return {
    request_id: request.concept_id,
    status: "held",
    origin: "input",
    necessity: request.necessity,
    support_status: support ? "support_ready" : "invalid",
    semantic_review_status: reviewStatus,
    outcome: "hold",
    definition_ja: support?.definition_ja ?? "",
    claim_refs: support?.claim_ref ? [support.claim_ref] : [],
    evidence_refs: support ? [support.evidence_ref] : [],
    document_ids: support ? [support.document_id] : [],
    support_spans: support ? [{
      evidence_ref: support.evidence_ref,
      document_id: support.document_id,
      quote: support.quote,
      subject_quote: support.subject_quote
    }] : [],
    applicable_at: document?.published_date ?? null,
    fetched_at: document?.fetched_at ?? null,
    reason_codes: [reason]
  };
}

function finalize(
  summaryHash: string,
  resolutions: ReaderContextResolution[],
  diagnostics: ReaderContextPlan["diagnostics"]
): ReaderContextPlan {
  return {
    summary_hash: summaryHash,
    resolutions,
    patches: resolutions.flatMap((item) => item.patch ? [item.patch] : []),
    needs_research: resolutions.filter((item) => item.outcome === "needs_research").map((item) => item.request_id),
    holds: resolutions.filter((item) => item.outcome === "hold").map((item) => item.request_id),
    diagnostics
  };
}

function summaryText(summary: SummarizedArticle) {
  return SUMMARY_FIELDS.map((field) => summary[field]).join("\n");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
