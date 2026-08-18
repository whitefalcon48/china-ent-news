import fs from "node:fs/promises";
import path from "node:path";
import { runClaimCheck, runCommentCheck } from "../claimCheck.js";
import { applyDisplayKanji, inspectDisplayKanjiResidues } from "../displayKanji.js";
import { generateLimitedReviewPatch, reviseTopicFromSavedData } from "../summarizeWithGemini.js";
import { getToneMode } from "../toneMode.js";
import { applyLightweightWhyItMattersEdit } from "./lightweightWhyItMattersEdit.js";
import {
  applyValidatedReviewPatch,
  buildFullRewriteTrace,
  buildReviewRevisionTrace,
  detectReviewRevisionIntent,
  ReviewRevisionClarificationRequiredError
} from "./revisionPatch.js";
import type { ClaimCheckResult, FactLedger, ProcessedArticle, RawArticle, ReviewPatchOperation, ReviewReasonTag, SummarizedArticle, TopicCandidate } from "../types.js";

export async function reviseStoredArticle(directory: string, index: number, comment: string, reasonTag: ReviewReasonTag | string = "その他") {
  const articleFile = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!articleFile) throw new Error(`articles JSON not found: ${directory}`);
  const articlePath = path.join(directory, articleFile);
  const articles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  const article = articles[index - 1];
  if (!article?.topic) throw new Error(`topic data not found for article ${index}`);
  if (!article.summary) throw new ReviewRevisionClarificationRequiredError("元記事が見つからないため、変更箇所を比較できません");
  const ledger = await findLedger(directory, article.topic.topic_key);
  const intent = detectReviewRevisionIntent(article.summary, comment, reasonTag);
  if (intent.mode === "clarification_required") throw new ReviewRevisionClarificationRequiredError(intent.clarification_reason);
  if (intent.mode === "limited_patch" && !ledger) {
    throw new ReviewRevisionClarificationRequiredError("事実台帳が見つからないため、限定修正の根拠claimを確認できません");
  }
  const lightweight = tryApplyLightweightWhyItMattersEdit(article.summary, article.topic, ledger, comment);
  if (intent.mode === "limited_patch" && lightweight) {
    const patch = minimalWhyItMattersPatch(article.summary.why_it_matters, lightweight.summary.why_it_matters);
    const trace = buildReviewRevisionTrace(article.summary, lightweight.summary, [patch], intent, comment);
    articles[index - 1] = {
      ...article,
      summary: lightweight.summary,
      generationMeta: {
        ...article.generationMeta,
        topic_key: article.generationMeta?.topic_key ?? article.topic.topic_key,
        ledger_used: article.generationMeta?.ledger_used ?? true,
        ledger_fallback_reason: article.generationMeta?.ledger_fallback_reason ?? "",
        display_normalization: { residues: lightweight.residues },
        claim_check: lightweight.claimCheck,
        review_revision: trace,
        comment_stage: {
          attempted: false,
          used: false,
          regenerated: false,
          fallback_reason: "review_literal_edit",
          exclamation_count: (lightweight.summary.why_it_matters.match(/[！!]/g) ?? []).length
        }
      }
    };
    await fs.writeFile(articlePath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
    return articles[index - 1];
  }
  if (intent.mode === "limited_patch") {
    const document = await generateLimitedReviewPatch(article.summary, ledger!, comment, intent);
    const patched = applyValidatedReviewPatch(article.summary, article.topic, ledger!, comment, reasonTag, intent, document);
    articles[index - 1] = {
      ...article,
      summary: patched.summary,
      generationMeta: {
        ...article.generationMeta,
        topic_key: article.generationMeta?.topic_key ?? article.topic.topic_key,
        ledger_used: true,
        ledger_fallback_reason: "",
        ledger: ledger ?? undefined,
        display_normalization: { residues: inspectDisplayKanjiResidues(patched.summary) },
        claim_check: patched.claimCheck,
        review_revision: patched.trace,
        comment_stage: {
          attempted: true,
          used: patched.trace.changed_fields.includes("why_it_matters"),
          regenerated: false,
          fallback_reason: "review_limited_patch",
          exclamation_count: (patched.summary.why_it_matters.match(/[！!]/g) ?? []).length
        }
      }
    };
    await fs.writeFile(articlePath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
    return articles[index - 1];
  }
  const evidence = rebuildEvidence(article);
  const revised = await reviseTopicFromSavedData(article.topic, evidence, ledger, comment, undefined, undefined, article.summary, false);
  articles[index - 1] = {
    ...article,
    summary: revised.summary,
    generationMeta: { ...revised.meta, review_revision: buildFullRewriteTrace(article.summary, revised.summary) }
  };
  await fs.writeFile(articlePath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
  return articles[index - 1];
}

function minimalWhyItMattersPatch(before: string, after: string): ReviewPatchOperation {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    field: "why_it_matters",
    operation: "replace",
    before: before.slice(prefix, before.length - suffix),
    after: after.slice(prefix, after.length - suffix),
    evidence_claim_refs: [],
    reason: "指定された一意な文言を限定編集"
  };
}

/**
 * A review comment may use this no-network path only when it makes one
 * unambiguous edit inside `why_it_matters`.  Validation failures intentionally
 * return null so the shared limited-patch path remains the fallback.
 */
export function tryApplyLightweightWhyItMattersEdit(
  summary: SummarizedArticle | undefined,
  topic: TopicCandidate,
  ledger: FactLedger | null,
  comment: string
): { summary: SummarizedArticle; residues: Array<{ field: string; chars: string[] }>; claimCheck: ClaimCheckResult } | null {
  if (!summary || !ledger) return null;
  const edit = applyLightweightWhyItMattersEdit(summary.why_it_matters, comment);
  if (!edit.ok) return null;

  // Apply the project-wide display normalization, then prove that it did not
  // alter any field except the explicitly permitted reader-facing comment.
  const normalized = applyDisplayKanji({ ...summary, why_it_matters: edit.value });
  if (!summaryFieldsExceptWhyItMattersMatch(summary, normalized.summary)) return null;
  if (normalized.residues.some((residue) => residue.field === "why_it_matters")) return null;

  const beforeGates = gateKeys(runClaimCheck(summary, ledger));
  const claimCheck = runClaimCheck(normalized.summary, ledger);
  const afterGates = gateKeys(claimCheck);
  if ([...afterGates].some((key) => !beforeGates.has(key))) return null;

  const toneMode = getToneMode(topic, ledger);
  const bodyClaimRefs = [
    ...summary.claim_refs.what_happened,
    ...(summary.detail_sections ?? []).flatMap((section) => section.claim_refs)
  ];
  const commentContext = {
    bodyText: `${summary.lead}\n${summary.what_happened}`,
    bodyClaimRefs,
    commentClaimRefs: summary.claim_refs.why_it_matters
  };
  const beforeCommentGates = gateKeys(runCommentCheck(summary.why_it_matters, "", ledger, topic, toneMode, commentContext));
  const afterCommentGates = gateKeys(runCommentCheck(
    normalized.summary.why_it_matters,
    "",
    ledger,
    topic,
    toneMode,
    commentContext
  ));
  if ([...afterCommentGates].some((key) => !beforeCommentGates.has(key))) return null;

  return { summary: normalized.summary, residues: normalized.residues, claimCheck };
}

function summaryFieldsExceptWhyItMattersMatch(before: SummarizedArticle, after: SummarizedArticle) {
  const beforeCopy = { ...before, why_it_matters: "" };
  const afterCopy = { ...after, why_it_matters: "" };
  return JSON.stringify(beforeCopy) === JSON.stringify(afterCopy);
}

function gateKeys(result: ClaimCheckResult | ReturnType<typeof runCommentCheck>) {
  const violations = Array.isArray(result) ? result : result.violations;
  return new Set(violations
    .filter((violation) => violation.severity === "gate")
    .map((violation) => `${violation.section}:${violation.rule}:${violation.detail}`));
}

export async function findLedger(directory: string, topicKey: string): Promise<FactLedger | null> {
  const ledgerFile = (await fs.readdir(directory)).filter((name) => /^fact_ledger_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!ledgerFile) return null;
  const stored = JSON.parse(await fs.readFile(path.join(directory, ledgerFile), "utf8")) as { ledgers?: Array<{ topic_key: string; ledger: FactLedger | null }> };
  return stored.ledgers?.find((item) => item.topic_key === topicKey)?.ledger || null;
}

function rebuildEvidence(article: ProcessedArticle): RawArticle[] {
  const topic = article.topic as TopicCandidate;
  if (!topic.evidence_articles.length) return [article.raw];
  return topic.evidence_articles.map((item, position) => position === 0 ? article.raw : ({
    title: item.title,
    url: item.url,
    sourceName: item.source_name,
    sourceUrl: item.url,
    category: article.raw.category,
    reliability: item.reliability,
    sourceType: item.source_type,
    publishedDate: item.published_date,
    freshnessLabel: item.freshness_label,
    articleType: item.article_type,
    excerpt: item.key_points.join("。")
  }));
}
