import { createHash } from "node:crypto";
import { fetchIntakeDocument, redactIntakeUrl, type IntakeDocument } from "../intake/fetchIntakeDocument.js";
import type {
  FactLedger,
  ProcessedArticle,
  ReviewEvidenceSupplement,
  ReviewPatchDocument,
  ReviewRevisionTrace,
  TopicCandidate
} from "../types.js";
import {
  applyValidatedReviewPatch,
  detectReviewRevisionIntent,
  ReviewRevisionClarificationRequiredError
} from "./revisionPatch.js";

/**
 * This is an operator-reviewed proposal path, not an automatic meaning
 * classifier. The operator supplies the Japanese definition and confirms the
 * meaning against the exact source/subject quotes; this module verifies only
 * safe retrieval, domain, exact quote presence, and bounded patch provenance.
 */

export type EvidenceSupplementRequest = {
  instruction: string;
  term: string;
  definition_ja: string;
  source_url: string;
  source_name: string;
  source_quote: string;
  subject_quote: string;
  reason: string;
  reviewed_by: string;
  before: string;
  after: string;
  existing_claim_refs: string[];
};

export type EvidenceSupplementOptions = {
  fetchDocument?: typeof fetchIntakeDocument;
};

export async function prepareEvidenceSupplement(
  article: ProcessedArticle,
  ledger: FactLedger,
  request: EvidenceSupplementRequest,
  options: EvidenceSupplementOptions = {}
) {
  const beforeSummary = article.summary;
  const topic = article.topic;
  if (!beforeSummary || !topic) fail("補足案には保存済みsummaryとtopicが必要です");
  if (ledger.topic_key !== topic.topic_key) fail("fact ledgerのtopic_keyが記事topicと一致しません");
  validateRequest(request);
  if (!beforeSummary.what_happened.includes(request.term)) fail("補足対象の用語が what_happened にありません");
  if (!beforeSummary.what_happened.includes(request.before) || countOccurrences(beforeSummary.what_happened, request.before) !== 1) {
    fail("before は what_happened に1回だけ完全一致する必要があります");
  }
  if (!request.before.includes(request.term) || !request.after.includes(request.term) || !request.after.includes(request.definition_ja)) {
    fail("before/after に補足対象と確認済み説明が揃っていません");
  }
  assertGovernmentUrl(request.source_url, "requested");
  assertExistingClaimRefs(beforeSummary.claim_refs.what_happened, ledger, request.existing_claim_refs);
  assertNoSourceReuse(beforeSummary, topic, request.source_url);

  const fetchDocument = options.fetchDocument ?? fetchIntakeDocument;
  const fetched = await fetchDocument(request.source_url);
  if (!fetched.ok) fail(`補足根拠の取得に失敗しました: ${fetched.error}`);
  assertGovernmentUrl(fetched.document.requested_url, "requested");
  assertGovernmentUrl(fetched.document.final_url, "final");
  assertNoSourceReuse(beforeSummary, topic, fetched.document.final_url);
  if (fetched.document.extraction_quality?.status !== "usable") fail("補足根拠の本文抽出品質が usable ではありません");
  assertExactQuote(fetched.document.text, request.source_quote, "source_quote");
  assertExactQuote(fetched.document.text, request.subject_quote, "subject_quote");
  if (!normalizeQuote(request.subject_quote).includes(normalizeQuote(request.term))) {
    fail("subject_quote に対象用語がありません");
  }

  const { evidenceRef, claimRef } = nextEvidenceAndClaimRefs(ledger);
  const augmentedLedger = appendSupplementLedger(ledger, request, evidenceRef, claimRef);
  const intent = detectReviewRevisionIntent(beforeSummary, request.instruction, "その他");
  if (
    intent.mode !== "limited_patch"
    || intent.explicit_fields.length !== 1
    || intent.explicit_fields[0] !== "what_happened"
    || intent.allowed_fields.length !== 1
    || intent.allowed_fields[0] !== "what_happened"
    || intent.required_field_rewrites.length > 0
  ) fail("指示は what_happened だけを明示した限定修正である必要があります");

  const document: ReviewPatchDocument = {
    mode: "limited_patch",
    clarification_required: false,
    clarification_reason: "",
    patches: [{
      field: "what_happened",
      operation: "replace",
      before: request.before,
      after: request.after,
      evidence_claim_refs: [...request.existing_claim_refs, claimRef],
      reason: "運用担当が公式根拠と変更前後を確認した概念補足"
    }]
  };
  const applied = applyValidatedReviewPatch(beforeSummary, topic, augmentedLedger, request.instruction, "その他", intent, document);
  const supplement = makeSupplement(request, fetched.document, evidenceRef, claimRef);
  const summary = {
    ...applied.summary,
    related_sources: [...applied.summary.related_sources, { name: request.source_name, url: fetched.document.final_url }]
  };
  const nextTopic = appendRelatedEvidence(topic, request, fetched.document);
  const trace: ReviewRevisionTrace = {
    ...applied.trace,
    preservation: { ...applied.trace.preservation, related_sources_exact: false }
  };
  const generationMeta = article.generationMeta
    ? structuredClone(article.generationMeta)
    : { topic_key: topic.topic_key, ledger_used: true, ledger_fallback_reason: "" };
  const nextArticle: ProcessedArticle = {
    ...structuredClone(article),
    summary,
    topic: nextTopic,
    generationMeta: {
      ...generationMeta,
      ledger: augmentedLedger,
      claim_check: applied.claimCheck,
      evidence_quality: augmentedLedger.evidence_quality,
      review_supplements: [...(generationMeta.review_supplements ?? []), supplement],
      review_revision: trace
    }
  };
  return {
    article: nextArticle,
    trace,
    summary: request.reason,
    evidenceUrls: [fetched.document.final_url],
    supplement
  };
}

function appendSupplementLedger(ledger: FactLedger, request: EvidenceSupplementRequest, evidenceRef: string, claimRef: string): FactLedger {
  const next = structuredClone(ledger);
  next.claims.push({
    id: claimRef,
    type: "verified_fact",
    text: request.definition_ja,
    evidence_refs: [evidenceRef],
    source_name: request.source_name,
    entities: [request.term],
    numbers: [],
    quote_zh: request.source_quote,
    anchor: true,
    scope: "related_angle",
    angle_kind: "other",
    editorial_role: "other"
  });
  next.evidence_roles = { ...next.evidence_roles, [evidenceRef]: "related_angle" };
  next.evidence_quality = [
    ...(next.evidence_quality ?? []),
    {
      evidence_ref: evidenceRef,
      classification: "primary",
      usable_for_verified_facts: true,
      reason: "official_government_domain_operator_reviewed_exact_quotes"
    }
  ];
  const existingTerm = next.terms.find((item) => item.term === request.term);
  if (existingTerm?.what_is && existingTerm.what_is !== request.definition_ja) fail("既存termの what_is と異なる説明は上書きできません");
  if (existingTerm) {
    existingTerm.what_is = existingTerm.what_is || request.definition_ja;
    existingTerm.explain_quote_zh = existingTerm.explain_quote_zh || request.source_quote;
    existingTerm.explain_evidence_refs = unique([...(existingTerm.explain_evidence_refs ?? []), evidenceRef]);
  } else {
    next.terms.push({
      term: request.term,
      gloss_ja: request.term,
      what_is: request.definition_ja,
      why_now: "",
      explain_quote_zh: request.source_quote,
      explain_evidence_refs: [evidenceRef]
    });
  }
  return next;
}

function appendRelatedEvidence(topic: TopicCandidate, request: EvidenceSupplementRequest, document: IntakeDocument): TopicCandidate {
  const existingRelated = structuredClone(topic.related_evidence_articles ?? []);
  return {
    ...structuredClone(topic),
    related_evidence_articles: [
      ...existingRelated,
      {
        title: document.title || request.source_name,
        url: document.final_url,
        source_name: request.source_name,
        source_type: "official",
        published_date: document.published_date,
        freshness_label: "unknown",
        article_type: "unknown",
        reliability: "A",
        key_points: [request.subject_quote, request.source_quote],
        angle_kind: "other"
      }
    ]
  };
}

function makeSupplement(request: EvidenceSupplementRequest, document: { final_url: string; title: string; published_date: string; fetched_at: string; text: string }, evidenceRef: string, claimRef: string): ReviewEvidenceSupplement {
  return {
    term: request.term,
    definition_ja: request.definition_ja,
    source_url: document.final_url,
    source_name: request.source_name,
    source_title: document.title,
    source_published_date: document.published_date,
    fetched_at: document.fetched_at,
    source_quote: request.source_quote,
    subject_quote: request.subject_quote,
    body_sha256: createHash("sha256").update(document.text, "utf8").digest("hex"),
    evidence_ref: evidenceRef,
    claim_ref: claimRef,
    reason: request.reason,
    reviewed_by: request.reviewed_by,
    verification: "operator_reviewed_exact_quotes"
  };
}

function nextEvidenceAndClaimRefs(ledger: FactLedger) {
  const maxEvidence = Math.max(0, ...[
    ...Object.keys(ledger.evidence_roles ?? {}),
    ...(ledger.evidence_quality ?? []).map((item) => item.evidence_ref),
    ...ledger.claims.flatMap((item) => item.evidence_refs),
    ...ledger.terms.flatMap((item) => item.explain_evidence_refs ?? []),
    ...ledger.japan_availability.evidence_refs
  ].map((value) => Number(/^E(\d+)$/u.exec(value)?.[1] ?? 0)));
  const maxClaim = Math.max(0, ...ledger.claims.map((item) => Number(/^C(\d+)$/u.exec(item.id)?.[1] ?? 0)));
  return { evidenceRef: `E${maxEvidence + 1}`, claimRef: `C${maxClaim + 1}` };
}

function assertExistingClaimRefs(current: string[], ledger: FactLedger, requested: string[]) {
  if (!requested.length || requested.length !== new Set(requested).size || requested.some((ref) => !current.includes(ref))) fail("existing_claim_refs は現在の what_happened の根拠を指す必要があります");
  const claims = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  if (requested.some((ref) => !claims.get(ref) || claims.get(ref)?.type === "unsupported")) fail("existing_claim_refs に利用できないclaimがあります");
}

function assertNoSourceReuse(summary: ProcessedArticle["summary"] & {}, topic: TopicCandidate, url: string) {
  const urls = [
    ...summary.source_list.map((item) => item.url),
    ...summary.related_sources.map((item) => item.url),
    ...topic.evidence_articles.map((item) => item.url),
    ...(topic.related_evidence_articles ?? []).map((item) => item.url)
  ];
  const canonicalUrl = redactIntakeUrl(url);
  if (!canonicalUrl || urls.map((item) => redactIntakeUrl(item ?? "")).includes(canonicalUrl)) fail("同一URLの補足根拠は再利用できません");
}

function assertGovernmentUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { fail(`${label} URLが不正です`); }
  const host = url!.hostname.toLowerCase();
  if (!/^https?:$/u.test(url!.protocol) || !(host === "gov.cn" || host.endsWith(".gov.cn") || host === "go.jp" || host.endsWith(".go.jp"))) {
    fail(`${label} URLは政府公式ドメインに限定されます`);
  }
}

function assertExactQuote(body: string, quote: string, label: string) {
  if (!normalizeQuote(body).includes(normalizeQuote(quote))) fail(`${label} が取得本文に完全一致しません`);
}

function validateRequest(request: EvidenceSupplementRequest) {
  const entries: Array<[string, string, number]> = [
    ["instruction", request.instruction, 1_000], ["term", request.term, 80], ["definition_ja", request.definition_ja, 120],
    ["source_url", request.source_url, 2_000], ["source_name", request.source_name, 120], ["source_quote", request.source_quote, 200],
    ["subject_quote", request.subject_quote, 200], ["reason", request.reason, 500], ["reviewed_by", request.reviewed_by, 120],
    ["before", request.before, 1_000], ["after", request.after, 1_000]
  ];
  for (const [name, value, limit] of entries) {
    if (!value?.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value) || /(?:```|\[.*\]\(|<\/?[a-z][^>]*>)/iu.test(value)) fail(`${name} の形式が不正です`);
  }
  if (request.source_quote.length + request.subject_quote.length > 400) fail("引用の合計は400字以内です");
  if (!request.existing_claim_refs.every((ref) => /^C\d+$/u.test(ref))) fail("existing_claim_refs の形式が不正です");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,119}$/u.test(request.reviewed_by)) fail("reviewed_by は記号を含まない担当者名にしてください");
}

function countOccurrences(value: string, needle: string) {
  let count = 0;
  let index = 0;
  while (needle && (index = value.indexOf(needle, index)) >= 0) { count += 1; index += needle.length; }
  return count;
}

function unique(values: string[]) { return [...new Set(values)]; }

function normalizeQuote(value: string) { return value.replace(/\s+/gu, ""); }

function fail(message: string): never { throw new ReviewRevisionClarificationRequiredError(message); }
