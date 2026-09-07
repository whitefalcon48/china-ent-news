import { createHash } from "node:crypto";
import { createDocumentId, normalizeEvidenceUrl } from "../evidence/evidenceManifest.js";
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
const SUMMARY_FIELDS = ["lead", "what_happened", "reaction_view", "why_it_matters", "japan_context_note"] as const;

type ProposedPatchRecord = {
  request: ReaderContextRequest;
  support: ReaderContextSupportCandidate;
  definition: string;
  patch: ReaderContextPatchProposal;
  resolution_indices: number[];
  conflicted: boolean;
};

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
  const proposedPatches: ProposedPatchRecord[] = [];
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
        source_published_at: null,
        fetched_at: null,
        reason_codes: []
      });
      continue;
    }

    const support = selectSupport(request, input.manifest, input.ledger, input.evidence);
    if (!support.ready) {
      diagnostics.push({ concept_id: request.concept_id, code: support.reason, message: support.message });
      resolutions.push(support.invalid
        ? holdResolution(request, support.reason)
        : researchResolution(request, support.reason));
      continue;
    }

    if (!support.candidate.claim_ref) {
      diagnostics.push({ concept_id: request.concept_id, code: "claim_binding_required", message: "原文spanは確認できましたが、適用可能なC/E対応がありません" });
      resolutions.push(holdResolution(request, "claim_binding_required", support.candidate, "not_run", input.manifest));
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
        first_occurrence: structuredClone(firstOccurrence),
        source: {
          source_name: document.source_name,
          url: document.final_url,
          role: binding.role,
          quote: support.candidate.quote,
          subject_quote: support.candidate.subject_quote,
          source_published_at: document.published_date,
          fetched_at: document.fetched_at,
          applicable_at: null
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
      const existingError = validateExistingExplanation(input.summary, request, firstOccurrence, existingSpan);
      if (existingError) {
        diagnostics.push({ concept_id: request.concept_id, code: existingError, message: "説明済みspanが対象概念の初出位置にありません" });
        resolutions.push(holdResolution(request, existingError, support.candidate, "hold", input.manifest));
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
      anchor_start: firstOccurrence.start,
      position: "after_first_occurrence",
      insert_text: definition,
      claim_refs: support.candidate.claim_ref ? [support.candidate.claim_ref] : [],
      evidence_refs: [support.candidate.evidence_ref],
      document_ids: [support.candidate.document_id],
      source_urls: [document.final_url],
      scope: binding.role === "root_corroboration" ? "root_event" : "related_angle"
    };
    const resolution: ReaderContextResolution = {
      ...baseSupportedResolution(request, support.candidate, input.manifest),
      status: "resolved",
      semantic_review_status: "pass",
      outcome: "patch_proposed",
      definition_ja: definition,
      reason_codes: review.reason_codes,
      patch
    };
    reconcilePatchProposal(request, support.candidate, definition, patch, resolution, proposedPatches, resolutions, diagnostics, input.manifest);
  }

  return finalize(summaryHash, resolutions, diagnostics);
}

function selectSupport(
  request: ReaderContextRequest,
  manifest: EvidenceManifest,
  ledger: FactLedger,
  evidence: RawArticle[]
): { ready: true; candidate: ReaderContextSupportCandidate } | { ready: false; invalid: boolean; reason: string; message: string } {
  if (!request.support_candidates.length) {
    return { ready: false, invalid: false, reason: "context_support_missing", message: "入力内に説明supportがありません" };
  }
  const failures: string[] = [];
  let claimBindingFallback: ReaderContextSupportCandidate | undefined;
  for (const candidate of request.support_candidates) {
    const failure = validateSupportCandidate(request, candidate, manifest, ledger, evidence);
    if (!failure) {
      if (candidate.claim_ref) return { ready: true, candidate };
      claimBindingFallback ??= candidate;
      continue;
    }
    failures.push(failure);
  }
  if (claimBindingFallback) return { ready: true, candidate: claimBindingFallback };
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
  ledger: FactLedger,
  evidence: RawArticle[]
) {
  if (!candidate.support_id.trim() || !candidate.definition_ja.trim()) return "support_candidate_invalid";
  if (candidate.support_kind !== "claim" && candidate.support_kind !== "term") return "support_kind_invalid";
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
  if (candidate.applicable_at !== undefined && candidate.applicable_at !== null) return "support_applicable_at_unverified";
  const inputVersionFailure = validateInputArticleVersion(
    binding.source_index === null ? undefined : evidence[binding.source_index],
    document
  );
  if (inputVersionFailure) return inputVersionFailure;
  if (document.storage_state !== "raw_content" || document.extraction_quality.status !== "usable") return "support_document_unusable";
  if (!document.integrity.usable_for_verified_facts) return "support_integrity_unusable";
  const sourceBody = binding.source_index === null ? "" : evidence[binding.source_index]?.rawContent ?? "";
  if (
    !normalizeWhitespace(sourceBody).includes(normalizeWhitespace(candidate.quote)) ||
    !normalizeWhitespace(sourceBody).includes(normalizeWhitespace(candidate.subject_quote))
  ) return "support_input_span_mismatch";
  const span = manifest.support_spans.find((item) =>
    item.evidence_ref === candidate.evidence_ref &&
    item.document_id === candidate.document_id &&
    normalizeWhitespace(item.quote) === normalizeWhitespace(candidate.quote) &&
    normalizeWhitespace(item.subject_quote) === normalizeWhitespace(candidate.subject_quote) &&
    item.validation_origin === "current_input_exact_body"
  );
  if (!span) return "support_span_unverified";
  if (candidate.support_kind === "claim" && !candidate.claim_ref) return "support_claim_invalid";
  if (candidate.claim_ref) {
    if (!/^C[1-9]\d*$/u.test(candidate.claim_ref)) return "support_claim_invalid";
    const claim = ledger.claims.find((item) => item.id === candidate.claim_ref);
    if (!claim || !claim.evidence_refs.includes(candidate.evidence_ref)) return "support_claim_ref_mismatch";
    if (claim.type === "unsupported") return "support_claim_unusable";
    if (normalizeWhitespace(claim.quote_zh ?? "") !== normalizeWhitespace(candidate.quote)) return "support_claim_quote_mismatch";
    const expectedScope = binding.role === "root_corroboration" ? "root_event" : "related_angle";
    if (claim.scope !== expectedScope) return "support_claim_scope_mismatch";
  }
  if (candidate.support_kind === "term") {
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
    const document = manifest.documents.find((item) => item.document_id === occurrence.document_id);
    if (!document) return "source_occurrence_ref_mismatch";
    const versionFailure = validateInputArticleVersion(evidence[binding.source_index], document);
    if (versionFailure) return "source_occurrence_version_mismatch";
    const body = evidence[binding.source_index]?.rawContent ?? "";
    if (!normalizeWhitespace(body).includes(normalizeWhitespace(occurrence.span))) return "source_occurrence_span_mismatch";
    if (![request.term, ...request.aliases].some((term) => term && occurrence.span.includes(term))) return "source_occurrence_term_mismatch";
  }
  return "";
}

function validateInputArticleVersion(article: RawArticle | undefined, document: EvidenceManifest["documents"][number]) {
  if (!article?.rawContent) return "input_body_missing";
  const bodyHash = sha256(article.rawContent);
  if (bodyHash !== document.body_sha256) return "input_body_hash_mismatch";
  if (createDocumentId(document.final_url, bodyHash) !== document.document_id) return "input_document_id_mismatch";
  const inputUrl = normalizeEvidenceUrl(article.url);
  const allowedUrls = new Set([
    document.requested_url,
    document.final_url,
    document.normalized_url
  ].map(normalizeEvidenceUrl).filter(Boolean));
  if (!inputUrl || !allowedUrls.has(inputUrl)) return "input_url_mismatch";
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
    if (match) return { field, anchor: match.anchor, start: match.index, end: match.index + match.anchor.length };
  }
  return null;
}

function validateExistingExplanation(
  summary: SummarizedArticle,
  request: ReaderContextRequest,
  firstOccurrence: NonNullable<ReturnType<typeof findFirstSummaryOccurrence>>,
  existingSpan: string
) {
  if (!existingSpan) return "existing_explanation_span_mismatch";
  if (![request.term, ...request.aliases].some((term) => term && existingSpan.includes(term))) {
    return "existing_explanation_concept_mismatch";
  }
  const fieldText = summary[firstOccurrence.field];
  const spanStart = fieldText.indexOf(existingSpan);
  if (spanStart < 0) {
    return SUMMARY_FIELDS.some((field) => summary[field].includes(existingSpan))
      ? "existing_explanation_not_at_first_occurrence"
      : "existing_explanation_span_mismatch";
  }
  const spanEnd = spanStart + existingSpan.length;
  if (spanStart > firstOccurrence.start || spanEnd < firstOccurrence.end) return "existing_explanation_not_at_first_occurrence";
  return "";
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

function reconcilePatchProposal(
  request: ReaderContextRequest,
  support: ReaderContextSupportCandidate,
  definition: string,
  patch: ReaderContextPatchProposal,
  resolution: ReaderContextResolution,
  records: ProposedPatchRecord[],
  resolutions: ReaderContextResolution[],
  diagnostics: ReaderContextPlan["diagnostics"],
  manifest: EvidenceManifest
) {
  const existing = records.find((record) =>
    conceptsOverlap(record.request, request) &&
    record.patch.field === patch.field &&
    record.patch.anchor_start === patch.anchor_start
  );
  if (!existing) {
    const resolutionIndex = resolutions.push(resolution) - 1;
    records.push({ request, support, definition, patch, resolution_indices: [resolutionIndex], conflicted: false });
    return;
  }
  if (existing.conflicted) {
    diagnostics.push({ concept_id: request.concept_id, code: "context_patch_conflict", message: "同一概念・初出位置に競合する説明案があります" });
    resolutions.push({
      ...baseSupportedResolution(request, support, manifest),
      semantic_review_status: "pass",
      outcome: "hold",
      definition_ja: definition,
      reason_codes: ["context_patch_conflict"]
    });
    return;
  }
  if (samePatchSupport(existing, support, definition)) {
    diagnostics.push({ concept_id: request.concept_id, code: "duplicate_context_patch_merged", message: "同一の説明案を既存patchへ統合しました" });
    const resolutionIndex = resolutions.push({
      ...baseSupportedResolution(request, support, manifest),
      status: "resolved",
      semantic_review_status: "pass",
      outcome: "merged",
      definition_ja: definition,
      reason_codes: ["duplicate_context_patch_merged"]
    }) - 1;
    existing.resolution_indices.push(resolutionIndex);
    return;
  }

  diagnostics.push({ concept_id: request.concept_id, code: "context_patch_conflict", message: "同一概念・初出位置に競合する説明案があります" });
  for (const index of existing.resolution_indices) {
    const prior = resolutions[index]!;
    resolutions[index] = {
      ...prior,
      status: "held",
      outcome: "hold",
      patch: undefined,
      reason_codes: [...new Set([...prior.reason_codes, "context_patch_conflict"])]
    };
  }
  existing.conflicted = true;
  resolutions.push({
    ...baseSupportedResolution(request, support, manifest),
    semantic_review_status: "pass",
    outcome: "hold",
    definition_ja: definition,
    reason_codes: ["context_patch_conflict"]
  });
}

function conceptsOverlap(left: ReaderContextRequest, right: ReaderContextRequest) {
  const leftTerms = new Set([left.term, ...left.aliases].map(normalizeConcept).filter(Boolean));
  return [right.term, ...right.aliases].map(normalizeConcept).some((term) => term && leftTerms.has(term));
}

function samePatchSupport(record: ProposedPatchRecord, support: ReaderContextSupportCandidate, definition: string) {
  return normalizeWhitespace(record.definition) === normalizeWhitespace(definition) &&
    record.support.claim_ref === support.claim_ref &&
    record.support.evidence_ref === support.evidence_ref &&
    record.support.document_id === support.document_id &&
    normalizeWhitespace(record.support.quote) === normalizeWhitespace(support.quote) &&
    normalizeWhitespace(record.support.subject_quote) === normalizeWhitespace(support.subject_quote);
}

function normalizeConcept(value: string) {
  return normalizeWhitespace(value).toLocaleLowerCase("ja-JP");
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
    applicable_at: null,
    source_published_at: document?.published_date ?? null,
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
    source_published_at: null,
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
    applicable_at: null,
    source_published_at: document?.published_date ?? null,
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
