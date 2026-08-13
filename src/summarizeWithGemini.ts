import fs from "node:fs/promises";
import path from "node:path";
import { ClaimCheckDiscardError, extractNumberTokens, getCommentOpening, removeGatedViolationSentences, runClaimCheck, runCommentCheck, sanitizeExclamations } from "./claimCheck.js";
import { inspectDisplayKanjiResidues } from "./displayKanji.js";
import { buildDeepSeekJsonRequest } from "./deepSeekRequest.js";
import { resolveAiModels, resolveStageAi } from "./aiRouting.js";
import { extractFactLedger } from "./factLedger.js";
import { consumeLlmCall, hasLlmBudgetRemaining, LlmCallBudgetExceededError, type LlmCallBudget } from "./llmCallBudget.js";
import { resolveSummaryTitle } from "./summaryTitle.js";
import { createTermExpansionSession, expandTermExplanation, type TermExpansionSession } from "./termExplainExpansion.js";
import { applyTerminology, formatTerminologyForPrompt } from "./terminology.js";
import { getToneMode } from "./toneMode.js";
import { assertToneOnlyRevisionContract, ToneOnlyRevisionContractError } from "./toneOnlyRevision.js";
import { ArticleDepthGateError, assessArticleDepth, type ArticleDepthProfile } from "./articleDepth.js";
import type {
  AiProvider,
  ArticleType,
  ContextValue,
  FeedBadge,
  FreshnessLabel,
  LevelLabel,
  RawArticle,
  SnsHeat,
  SourceTypeLabel,
  PublishPriority,
  SummarizedArticle,
  TopicCandidate,
  FactLedger,
  ClaimCheckResult,
  ClaimCheckViolation,
  TopicGenerationMeta
} from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export const OUTPUT_COUNT_INSTRUCTION = "Output every candidate item that is worth publishing; do not force a 3-5 item cap. Add publish_priority (high/medium/low) and publish_reason to every output article.";

let editorialCharacterCache: string | undefined;
let bingtangCharacterCache: string | undefined;

type CommentGenerationContext = { angleHint?: string; usedOpenings?: string[]; termExpansionSession?: TermExpansionSession; articleDepthProfile?: ArticleDepthProfile };

async function loadEditorialCharacter() {
  if (editorialCharacterCache !== undefined) {
    return editorialCharacterCache;
  }

  try {
    editorialCharacterCache = await fs.readFile(path.resolve("docs", "editorial-character.md"), "utf8");
  } catch {
    editorialCharacterCache = "Read local editorial-character policy if available. Focus on China-local entertainment context, Japan visibility gaps, cautious handling of PR, rumors, and SNS heat.";
  }

  return editorialCharacterCache;
}

async function loadBingtangCharacter() {
  if (bingtangCharacterCache !== undefined) {
    return bingtangCharacterCache;
  }

  try {
    bingtangCharacterCache = await fs.readFile(path.resolve("docs", "character-bingtang-v2.md"), "utf8");
  } catch {
    bingtangCharacterCache = "Use a polite but lively assistant voice. Do not use character preferences as facts or selection evidence.";
  }

  return bingtangCharacterCache;
}

export async function summarizeArticle(article: RawArticle, provider = getAiProvider(), budget?: LlmCallBudget): Promise<SummarizedArticle> {
  const text = await generateJson(provider, await buildPrompt(article), budget);
  return clearEditorComment(await applyTerminology(mergeInternalMetadata(normalizeSummary(parseJsonFromModelText(text)), article)));
}

export async function summarizeTopic(
  topic: TopicCandidate,
  evidence: RawArticle[],
  provider: AiProvider = getAiProvider(),
  budget?: LlmCallBudget,
  commentContext: CommentGenerationContext = {}
): Promise<{ summary: SummarizedArticle; meta: TopicGenerationMeta }> {
  evidence = withTopicRelatedEvidence(topic, evidence);
  const articleDepthProfile = commentContext.articleDepthProfile ?? "standard";
  const aiModels = resolveAiModels(provider);
  const ledgerAi = resolveStageAi("ledger", provider);
  const commentAi = resolveStageAi("comment", provider);
  if (process.env.FACT_LEDGER === "false") {
    const text = await generateJson(provider, await buildTopicPrompt(topic, evidence), budget);
    const summary = clearEditorComment(await applyTerminology(mergeTopicInternalMetadata(normalizeSummary(parseJsonFromModelText(text)), topic, evidence)));
    const residues = inspectDisplayKanjiResidues(summary);
    return {
      summary,
      meta: {
        topic_key: topic.topic_key,
        ledger_used: false,
        ledger_fallback_reason: "fact_ledger_disabled_env",
        ai_models: aiModels,
        display_normalization: { residues }
      }
    };
  }

  const extraction = await extractFactLedger(topic, evidence, ledgerAi.provider, budget, ledgerAi.model);
  if (!extraction.succeeded || !extraction.ledger) {
    if (extraction.error.includes("llm_call_budget_exceeded")) {
      throw new LlmCallBudgetExceededError();
    }
    const text = await generateJson(provider, await buildTopicPrompt(topic, evidence), budget);
    const summary = clearEditorComment(await applyTerminology(mergeTopicInternalMetadata(normalizeSummary(parseJsonFromModelText(text)), topic, evidence)));
    const residues = inspectDisplayKanjiResidues(summary);
    return {
      summary,
      meta: {
          topic_key: topic.topic_key,
          ledger_used: false,
          ledger_fallback_reason: `ledger_extraction_failed:${extraction.error}`,
          ai_models: aiModels,
          display_normalization: { residues }
      }
    };
  }

  const ledger = extraction.ledger;
  const termExpansionSession = commentContext.termExpansionSession ?? createTermExpansionSession();
  const ledgerEvidence = [...evidence];
  await expandTermExplanation(topic, ledgerEvidence, ledger, ledgerAi.provider, aiModels.ledger.model, budget, termExpansionSession, {
    generate: generateJson
  });
  let text = await generateJson(provider, await buildLedgerWritingPrompt(topic, ledger, [], articleDepthProfile), budget);
  let summary = normalizeSummaryClaimRefs(await applyTerminology(normalizeSummary(parseJsonFromModelText(text))), ledger);
  summary = ensureObservableReactionView(summary, ledger);
  summary = repairManualFactSectionGrounding(summary, ledger, articleDepthProfile);
  summary = enforceStandardArticleFormat(summary, articleDepthProfile);
  summary = ensureCanonicalPersonName(summary, topic, ledger);
  let claimCheck = runClaimCheck(summary, ledger);

  if (claimCheck.gated_violation_count > 0) {
    summary = removeGatedViolationSentences(summary, claimCheck.violations);
    claimCheck = { ...runClaimCheck(summary, ledger), action: "text_removed" };
    if (claimCheck.gated_violation_count > 0) {
      const gatedViolations = claimCheck.violations.filter((violation) => violation.severity === "gate");
      text = await generateJson(provider, await buildLedgerWritingPrompt(topic, ledger, gatedViolations, articleDepthProfile), budget);
      summary = normalizeSummaryClaimRefs(await applyTerminology(normalizeSummary(parseJsonFromModelText(text))), ledger);
      summary = ensureObservableReactionView(summary, ledger);
      summary = repairManualFactSectionGrounding(summary, ledger, articleDepthProfile);
      summary = enforceStandardArticleFormat(summary, articleDepthProfile);
      summary = ensureCanonicalPersonName(summary, topic, ledger);
      claimCheck = { ...runClaimCheck(summary, ledger), action: "regenerated" };
      if (claimCheck.gated_violation_count > 0) {
        claimCheck = { ...claimCheck, action: "discarded" };
        throw new ClaimCheckDiscardError(claimCheck.violations.filter((violation) => violation.severity === "gate"));
      }
    }
  }

  let articleDepth = assessArticleDepth(summary, ledger, articleDepthProfile);
  let writingFailures = manualWritingFailures(summary, ledger, topic);
  if ((!articleDepth.passed || writingFailures.length) && articleDepthProfile === "manual_evidence_rich") {
    const retryPrompt = `${await buildLedgerWritingPrompt(topic, ledger, [], articleDepthProfile, [...articleDepth.reasons, ...writingFailures])}\n\n前回の下書きJSON:\n${JSON.stringify(summary, null, 2)}\n\n前回の根拠付き記述を捨てず、重複を避けて必要節数と検証済みrelated angleの反映を修正してください。`;
    text = await generateJson(provider, retryPrompt, budget);
    summary = normalizeSummaryClaimRefs(await applyTerminology(normalizeSummary(parseJsonFromModelText(text))), ledger);
    summary = ensureObservableReactionView(summary, ledger);
    summary = repairManualFactSectionGrounding(summary, ledger, articleDepthProfile);
    summary = enforceStandardArticleFormat(summary, articleDepthProfile);
    summary = ensureCanonicalPersonName(summary, topic, ledger);
    claimCheck = { ...runClaimCheck(summary, ledger), action: "regenerated" };
    if (claimCheck.gated_violation_count > 0) {
      throw new ClaimCheckDiscardError(claimCheck.violations.filter((violation) => violation.severity === "gate"));
    }
    articleDepth = assessArticleDepth(summary, ledger, articleDepthProfile, true);
    if (!articleDepth.passed) throw new ArticleDepthGateError(articleDepth);
    writingFailures = manualWritingFailures(summary, ledger, topic);
    if (writingFailures.length) throw new Error(`manual_writing_gate:${writingFailures.join(",")}`);
  }

  const toneMode = getToneMode(topic, ledger);
  const originalComments = { why_it_matters: summary.why_it_matters, refs: summary.claim_refs.why_it_matters };
  const gatedCommentSentencesRemoved: string[] = [];
  const unmatchedCommentNumbers: string[] = [];
  const commentStage = { attempted: false, used: false, regenerated: false, fallback_reason: "", exclamation_count: countExclamations(summary.why_it_matters), opening: "", regenerated_opening: false, regenerated_paraphrase: false };
  if (process.env.COMMENT_STAGE === "false") {
    commentStage.fallback_reason = "comment_stage_disabled_env";
  } else if (budget && !hasLlmBudgetRemaining(budget)) {
    commentStage.fallback_reason = "llm_call_budget_exhausted";
  } else {
    commentStage.attempted = true;
    try {
      let comments = await generateBingtangComments(topic, ledger, summary, toneMode, commentAi.provider, budget, [], "", commentContext, commentAi.model);
      const checkContext = { usedOpenings: commentContext.usedOpenings, bodyText: articleBodyText(summary) };
      let commentViolations = runCommentCheck(comments.why_it_matters, "", ledger, topic, toneMode, checkContext);
      unmatchedCommentNumbers.push(...unmatchedNumbersFromViolations(commentViolations));
      if (needsCommentRegeneration(commentViolations, comments.why_it_matters, "", toneMode)) {
        commentStage.regenerated = true;
        commentStage.regenerated_opening = commentViolations.some((violation) => violation.rule === "comment_opening_duplicate");
        commentStage.regenerated_paraphrase = commentViolations.some((violation) => violation.rule === "comment_paraphrase");
        comments = await generateBingtangComments(topic, ledger, summary, toneMode, commentAi.provider, budget, commentViolations, "", commentContext, commentAi.model);
        commentViolations = runCommentCheck(comments.why_it_matters, "", ledger, topic, toneMode, checkContext);
        unmatchedCommentNumbers.push(...unmatchedNumbersFromViolations(commentViolations));
      }
      const gated = commentViolations.filter((violation) => violation.severity === "gate");
      if (gated.length) {
        gatedCommentSentencesRemoved.push(...gated.map((violation) => violation.detail));
        unmatchedCommentNumbers.push(...gated.filter((violation) => violation.rule === "comment_number_not_in_ledger").flatMap((violation) => extractNumberTokens(violation.detail)));
        comments.why_it_matters = removeCommentViolationSentences(comments.why_it_matters, gated);
      }
      if (!comments.why_it_matters.trim()) {
        Object.assign(comments, originalComments);
        commentStage.fallback_reason = "comment_gate_removed_why_it_matters";
      } else {
        commentStage.used = true;
      }
      summary.why_it_matters = sanitizeExclamations(comments.why_it_matters, toneMode);
      summary.editor_comment = "";
      summary.claim_refs.why_it_matters = filterClaimRefs(comments.refs, ledger);
      commentStage.exclamation_count = countExclamations(summary.why_it_matters);
      commentStage.opening = getCommentOpening(summary.why_it_matters);
    } catch (error) {
      summary.why_it_matters = originalComments.why_it_matters;
      summary.editor_comment = "";
      summary.claim_refs.why_it_matters = originalComments.refs;
      commentStage.fallback_reason = error instanceof LlmCallBudgetExceededError ? "llm_call_budget_exhausted" : `comment_stage_failed:${describeError(error)}`;
    }
  }

  const finalCommentViolations = runCommentCheck(summary.why_it_matters, "", ledger, topic, toneMode, {
    usedOpenings: commentContext.usedOpenings,
    bodyText: articleBodyText(summary)
  });
  const finalCommentGates = finalCommentViolations.filter((violation) => violation.severity === "gate");
  if (finalCommentGates.length) {
    gatedCommentSentencesRemoved.push(...finalCommentGates.map((violation) => violation.detail));
    unmatchedCommentNumbers.push(...finalCommentGates.filter((violation) => violation.rule === "comment_number_not_in_ledger").flatMap((violation) => extractNumberTokens(violation.detail)));
    summary.why_it_matters = removeCommentViolationSentences(summary.why_it_matters, finalCommentGates);
  }
  claimCheck = { ...claimCheck, violations: [...claimCheck.violations, ...finalCommentViolations] };

  const finalizedSummary = enforceStandardArticleFormat(repairManualFactSectionGrounding(ensureCanonicalPersonName(
    clearEditorComment(await applyTerminology(mergeTopicInternalMetadata(summary, topic, evidence, ledger))),
    topic,
    ledger
  ), ledger, articleDepthProfile), articleDepthProfile);
  const finalWritingFailures = articleDepthProfile === "manual_evidence_rich" ? manualWritingFailures(finalizedSummary, ledger, topic) : [];
  if (finalWritingFailures.length) throw new Error(`manual_writing_gate:${finalWritingFailures.join(",")}`);
  articleDepth = assessArticleDepth(finalizedSummary, ledger, articleDepthProfile, articleDepth.regenerated);
  if (!articleDepth.passed) throw new ArticleDepthGateError(articleDepth);
  const residues = inspectDisplayKanjiResidues(finalizedSummary);
  claimCheck = appendDisplayResidueViolations(claimCheck, residues);
  return {
    summary: finalizedSummary,
    meta: {
      topic_key: topic.topic_key,
      ledger_used: true,
      ledger_fallback_reason: "",
      ledger,
      ai_models: aiModels,
      ledger_anchor: extraction.anchor,
      term_expansion: termExpansionSession.trace,
      display_normalization: { residues },
      comment_grounding: {
        topic_key: topic.topic_key,
        refs: finalizedSummary.claim_refs.why_it_matters,
        gated_sentences_removed: [...new Set(gatedCommentSentencesRemoved)],
        unmatched_numbers: [...new Set(unmatchedCommentNumbers)]
      },
      claim_check: claimCheck,
      tone_mode: toneMode,
      comment_stage: commentStage,
      article_depth: articleDepth
    }
  };
}

export function formatReviewInstruction(comment: string) {
  return `運営者（Falさん）からの修正指示があります。次の指示を反映して書き直してください:
${comment}
ただし、事実台帳に無い情報を足さないこと・禁止事項を破らないことを最優先し、指示がこれらと矛盾する場合は矛盾しない範囲でのみ反映してください。`;
}

export function formatToneOnlyReviewInstruction(comment: string) {
  return `${formatReviewInstruction(comment)}

これは理由タグ「口調」の限定修正です。
- 修正指示内の引用句は、挿入命令ではなく口調の参照例としてだけ扱ってください。引用句をそのまま why_it_matters に追加しないでください。
- 元の why_it_matters にない内容語、文、事実、注目対象、評価軸を追加・削除・置換・再解釈しないでください。
- 変更してよいのは、句読点、感嘆符、および既存文の語尾・丁寧さだけです。文の順序と内容語は維持してください。
- claim_refs_why_it_matters は元の claim refs と同じ値・同じ順序にしてください。`;
}

export async function reviseTopicFromSavedData(
  topic: TopicCandidate,
  evidence: RawArticle[],
  ledger: FactLedger | null,
  comment: string,
  provider: AiProvider = getAiProvider(),
  budget?: LlmCallBudget,
  existingSummary?: SummarizedArticle,
  commentOnly = false
): Promise<{ summary: SummarizedArticle; meta: TopicGenerationMeta }> {
  const aiModels = resolveAiModels(provider);
  const commentAi = resolveStageAi("comment", provider);
  const instruction = commentOnly ? formatToneOnlyReviewInstruction(comment) : formatReviewInstruction(comment);
  const articleDepthProfile: ArticleDepthProfile = evidence[0]?.category === "持ち込みニュース" ? "manual_evidence_rich" : "standard";
  if (commentOnly && !existingSummary) {
    throw new ToneOnlyRevisionContractError("元の要約が見つからないため比較できません");
  }
  if (!ledger) {
    if (commentOnly) throw new ToneOnlyRevisionContractError("事実台帳が見つからないため claim refs を固定できません");
    const text = await generateJson(provider, `${await buildTopicPrompt(topic, evidence)}\n\n${instruction}`, budget);
    const summary = clearEditorComment(await applyTerminology(mergeTopicInternalMetadata(normalizeSummary(parseJsonFromModelText(text)), topic, evidence)));
    const residues = inspectDisplayKanjiResidues(summary);
    return {
      summary,
      meta: { topic_key: topic.topic_key, ledger_used: false, ledger_fallback_reason: "review_saved_ledger_missing", ai_models: aiModels, display_normalization: { residues } }
    };
  }
  let summary: SummarizedArticle;
  if (commentOnly && existingSummary) {
    summary = { ...existingSummary, claim_refs: { ...existingSummary.claim_refs } };
  } else {
    const text = await generateJson(provider, `${await buildLedgerWritingPrompt(topic, ledger, [], articleDepthProfile)}\n\n${instruction}`, budget);
    summary = normalizeSummaryClaimRefs(await applyTerminology(normalizeSummary(parseJsonFromModelText(text))), ledger);
  }
  summary = normalizeSummaryClaimRefs(summary, ledger);
  let claimCheck = runClaimCheck(summary, ledger);
  if (claimCheck.gated_violation_count > 0) {
    summary = removeGatedViolationSentences(summary, claimCheck.violations);
    claimCheck = { ...runClaimCheck(summary, ledger), action: "text_removed" };
  }
  if (claimCheck.gated_violation_count > 0) {
    throw new ClaimCheckDiscardError(claimCheck.violations.filter((violation) => violation.severity === "gate"));
  }
  const articleDepth = assessArticleDepth(summary, ledger, articleDepthProfile);
  if (!articleDepth.passed) throw new ArticleDepthGateError(articleDepth);
  const toneMode = getToneMode(topic, ledger);
  const gatedCommentSentencesRemoved: string[] = [];
  const unmatchedCommentNumbers: string[] = [];
  const commentStage = { attempted: false, used: false, regenerated: false, fallback_reason: "", exclamation_count: countExclamations(summary.why_it_matters) };
  if (process.env.COMMENT_STAGE !== "false" && (!budget || hasLlmBudgetRemaining(budget))) {
    commentStage.attempted = true;
    const comments = await generateBingtangComments(topic, ledger, summary, toneMode, commentAi.provider, budget, [], instruction, {}, commentAi.model);
    const violations = runCommentCheck(comments.why_it_matters, "", ledger, topic, toneMode);
    unmatchedCommentNumbers.push(...unmatchedNumbersFromViolations(violations));
    if (needsCommentRegeneration(violations, comments.why_it_matters, "", toneMode)) {
      const retry = await generateBingtangComments(topic, ledger, summary, toneMode, commentAi.provider, budget, violations, instruction, {}, commentAi.model);
      Object.assign(comments, retry);
      commentStage.regenerated = true;
    }
    const finalViolations = runCommentCheck(comments.why_it_matters, "", ledger, topic, toneMode, { bodyText: articleBodyText(summary) });
    const gates = finalViolations.filter((violation) => violation.severity === "gate");
    if (gates.length) {
      gatedCommentSentencesRemoved.push(...gates.map((violation) => violation.detail));
      unmatchedCommentNumbers.push(...gates.filter((violation) => violation.rule === "comment_number_not_in_ledger").flatMap((violation) => extractNumberTokens(violation.detail)));
      comments.why_it_matters = removeCommentViolationSentences(comments.why_it_matters, gates);
    }
    summary.why_it_matters = sanitizeExclamations(comments.why_it_matters, toneMode);
    summary.editor_comment = "";
    summary.claim_refs.why_it_matters = commentOnly && existingSummary
      ? [...existingSummary.claim_refs.why_it_matters]
      : filterClaimRefs(comments.refs, ledger);
    commentStage.used = true;
    commentStage.exclamation_count = countExclamations(summary.why_it_matters);
  } else {
    commentStage.fallback_reason = process.env.COMMENT_STAGE === "false" ? "comment_stage_disabled_env" : "llm_call_budget_exhausted";
  }
  const finalCommentViolations = runCommentCheck(summary.why_it_matters, "", ledger, topic, toneMode, { bodyText: articleBodyText(summary) });
  const finalCommentGates = finalCommentViolations.filter((violation) => violation.severity === "gate");
  if (finalCommentGates.length) {
    gatedCommentSentencesRemoved.push(...finalCommentGates.map((violation) => violation.detail));
    unmatchedCommentNumbers.push(...finalCommentGates.filter((violation) => violation.rule === "comment_number_not_in_ledger").flatMap((violation) => extractNumberTokens(violation.detail)));
    summary.why_it_matters = removeCommentViolationSentences(summary.why_it_matters, finalCommentGates);
  }
  claimCheck = { ...claimCheck, violations: [...claimCheck.violations, ...finalCommentViolations] };
  const finalizedSummary = clearEditorComment(await applyTerminology(mergeTopicInternalMetadata(summary, topic, evidence)));
  if (commentOnly && existingSummary) assertToneOnlyRevisionContract(existingSummary, finalizedSummary);
  const residues = inspectDisplayKanjiResidues(finalizedSummary);
  claimCheck = appendDisplayResidueViolations(claimCheck, residues);
  return {
    summary: finalizedSummary,
    meta: {
      topic_key: topic.topic_key,
      ledger_used: true,
      ledger_fallback_reason: "",
      ledger,
      ai_models: aiModels,
      display_normalization: { residues },
      comment_grounding: {
        topic_key: topic.topic_key,
        refs: finalizedSummary.claim_refs.why_it_matters,
        gated_sentences_removed: [...new Set(gatedCommentSentencesRemoved)],
        unmatched_numbers: [...new Set(unmatchedCommentNumbers)]
      },
      claim_check: claimCheck,
      tone_mode: toneMode,
      comment_stage: commentStage,
      article_depth: articleDepth
    }
  };
}

export async function summarizeWithGemini(article: RawArticle): Promise<SummarizedArticle> {
  return summarizeArticle(article, "gemini");
}

export async function testGeminiConnection() {
  return testAiConnection("gemini");
}

export async function testDeepSeekConnection() {
  return testAiConnection("deepseek");
}

export async function testAiConnection(provider: AiProvider) {
  const text = await generateJson(
    provider,
    `次のJSONだけを返してください。
{
  "ok": true,
  "message": "${provider} connection test succeeded"
}`
  );

  return parseJsonFromModelText(text) as {
    ok?: boolean;
    message?: string;
  };
}

export function getAiProvider(): AiProvider {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "deepseek") {
    return "deepseek";
  }
  return "gemini";
}

export function getGeminiEnvStatus() {
  return getProviderEnvStatus("gemini");
}

export function getProviderEnvStatus(provider: AiProvider) {
  if (provider === "deepseek") {
    return {
      provider,
      hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
    };
  }

  return {
    provider,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
  };
}

export function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = formatCause((error as Error & { cause?: unknown }).cause);
  return cause ? `${error.message} / cause: ${cause}` : error.message;
}

export async function generateJson(provider: AiProvider, prompt: string, budget?: LlmCallBudget, model?: string) {
  if (provider === "deepseek") {
    return generateDeepSeekJson(prompt, budget, model);
  }
  // Gemini can occasionally return an empty body or a transient 5xx while a
  // manual intake is otherwise valid. Retry only those provider-side failures;
  // parsing and quality-gate failures remain visible and are never bypassed.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await generateGeminiJson(prompt, budget, model);
    } catch (error) {
      lastError = error;
      if (!isTransientGeminiError(error) || attempt === 1) throw error;
    }
  }
  throw lastError;
}

function isTransientGeminiError(error: unknown) {
  return error instanceof Error && /Gemini (?:network error|API error: (?:empty response text|HTTP (?:429|5\d\d)))/u.test(error.message);
}

async function generateGeminiJson(prompt: string, budget?: LlmCallBudget, modelOverride?: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY is not set. .envまたはGitHub SecretsにAPIキーを設定してください。");
  }

  if (budget) consumeLlmCall(budget);

  let response: Response;
  try {
    response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          maxOutputTokens: 8192
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    });
  } catch (error) {
    throw new Error(`Gemini network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: HTTP ${response.status} ${response.statusText} ${safePreview(text)}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";

  if (!text.trim()) {
    throw new Error("Gemini API error: empty response text");
  }

  return text;
}

async function generateDeepSeekJson(prompt: string, budget?: LlmCallBudget, modelOverride?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = modelOverride || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

  if (!apiKey?.trim()) {
    throw new Error("DEEPSEEK_API_KEY is not set. .envまたはGitHub SecretsにAPIキーを設定してください。");
  }

  // DeepSeek occasionally acknowledges a valid request with an empty choice.
  // Retry only that transient response once; HTTP/network failures remain
  // fail-fast so we do not hide a broken provider configuration.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budget) consumeLlmCall(budget);
    let response: Response;
    try {
      response = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(buildDeepSeekJsonRequest(model, prompt))
      });
    } catch (error) {
      throw new Error(`DeepSeek network error: ${describeError(error)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek API error: HTTP ${response.status} ${response.statusText} ${safePreview(text)}`);
    }

    const payload = (await response.json()) as DeepSeekResponse;
    const text = payload.choices?.[0]?.message?.content ?? "";
    if (text.trim()) return text;
  }

  throw new Error("DeepSeek API error: empty response text after 2 attempts");
}

async function buildPrompt(article: RawArticle) {
  const editorialCharacter = await loadEditorialCharacter();

  return `あなたは中国エンタメの最新順フィードを作る編集補助AIです。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy for title angle, hitokoto, Japan-context notes, PR WATCH handling, HOT SEARCH handling, and cautious rumor wording.

Output count instruction for this generation run:
${OUTPUT_COUNT_INSTRUCTION}

publish_priority rules:
- publish_priority: high means strongly aligned with this project and should be prioritized.
- publish_priority: medium means useful reference value and publishable.
- publish_priority: low means collectable information but low priority for regular distribution.
- publish_reason must briefly explain the priority, such as industry lineup visibility, drama/streaming production trend, weak China-entertainment context, or official source with production-environment significance.


目的:
- 表に出す文章は、ナルエビちゃんニュース型の軽いニュースメモにする。
- 1本あたりの日本語本文量は通常400〜700字程度を目安にする。公式発表系は300〜500字でもよい。ゴシップ・騒動系は500〜800字程度まで許容する。
- 裏側では、元記事に書かれている内容だけを抽出し、記事タイプ、確度、ソース状況、topic_keyを整理する。
- 真偽判定や独自検証はしない。収集済み情報の抽出、分類、再構成だけを行う。

編集キャラクター:
- このサイトは中国語記事の翻訳・要約サイトではない。
- 中国現地で評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋める。
- 架空の中立ニュースキャスターを装わず、明示された編集軸に基づく編集視点で書く。
- 何が起きたかだけでなく、なぜそれが面白いのかを拾う。
- 日本語圏では見えにくい文脈がある場合だけ、短く補足する。
- 公式発表は確度Aでも中立とは限らない。官製PR、文化輸出、対外発信、国策文脈は一歩引いて見る。
- Weibo热搜などのSNS話題は現地温度の観測メモとして扱い、真偽判定を目的にしない。
- 中国特有のファン文化や用語（飯圏、流量、控評、番位、CP、营销号、塌房など）は必要に応じて短く補足する。

必ず次の順番で考える:
1. 抽出: 元記事に書かれている人物名、作品名、日付、数字、公式発表、報道内容、SNS反応、未確認表現、出典情報だけを取り出す。
2. 分類: article_type を判定する。分類は news_event / official_announcement / data_report / gossip_rumor / sns_trend / column_opinion / review / interview / static_page / unknown のいずれか。
3. 整理: 抽出結果だけを使い、軽く読める日本語ニュースメモにする。

禁止事項:
- 元記事にない情報を補わない。
- 業界一般論や背景説明で空欄を埋めない。
- 未確認情報を断定しない。
- 1ソースだけの場合、無理に複数ソース確認済みのように書かない。
- 出典にない人物評価、作品評価、興行評価を書かない。
- 中国人名や作品名を勝手に日本語読みへ変換しない。
- 原文の固有名詞はできるだけ原文表記も残す。
- コラム、論説、レビュー、インタビュー、静的ページをニュースイベントのように書かない。

タイトル生成ルール:
- 事実だけの固い見出しにしない。
- 「なぜ面白いか」「どこが引っかかるか」が少し見えるようにする。
- 試算・予測は「試算も」「見込み」「可能性」などを付ける。
- 感嘆符や断定調で煽らない。
- ゴシップ系は断定しない。
- 作品名・人名は勝手に日本語読みへ変換しない。ただし文字は公開本文の全フィールドで日本の新字体へ統一する（例: 张艺谋→張芸謀）。日本の新字体に対応する漢字がない場合だけ原文の簡体字を残す。初出で必要なら日本語仮訳を添える。

出し分けルール:
- lead は2〜3行程度。何が起きたかが軽く分かる文章にする。
- what_happened は150〜250字程度で、出来事・数字・日付・関係者を整理する。
- reaction_view は元記事内にSNS反応、読者反応、複数メディアでの見られ方、話題性、業界的意味がある場合に150〜250字程度で書く。根拠がなければ空文字。
- editor_comment は常に空文字にする。
- japan_context_note は公開時に「ビンタンからの補足」として表示する。日本語圏の読者が本文だけではつかみにくい文脈、ファン文化、方言・地域文化、日本公開・字幕情報などを、事実台帳の根拠がある場合だけビンタンの声で補足する。why_it_matters の「なぜ今気になるか」や次に見る点を繰り返さない。なければ空文字。
- 各記事は lead とは別に、what_happened と why_it_matters / reaction_view のいずれかを含め、最低2つの本文セクションを埋める。ただし根拠がない反応は作らない。
- SNS情報が元記事にない場合、has_sns_signal は false、reaction_view は空文字にする。
- 公式発表が記事内で確認できない場合、has_official_source は false にする。
- 1ソースのみの場合、has_multiple_sources は false にする。
- column_opinion / review / interview / static_page は skip_reason を必ず入れる。
- badge は NEWS / HOT SEARCH / WATCH / OFFICIAL / DATA / PR WATCH のいずれか。
- source_type は official / media_report / sns / data / pr_like / rumor / mixed のいずれか。
- HOT SEARCHは通常ニュースと同じフィードに混ぜるが、断定しない。公式発表や大手報道がない場合、confidence は C または D にする。
- PR WATCHは官製PRや文化交流記事をそのまま流さず、何を外向きに見せたい記事かをひとことで補足する。
- ゴシップでは「報じられた」「SNS上で話題になっている」など情報源に応じた表現にする。
- ゴシップや未確認情報がある場合、本人・事務所・公式側の反応有無と出典の弱さを verification_status に反映する。
- 原文を翻訳調でなぞらず、日本語として自然に再構成する。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "title_ja": "",
  "badge": "NEWS",
  "lead": "",
  "what_happened": "",
  "why_it_matters": "",
  "reaction_view": "",
  "editor_comment": "",
  "japan_context_note": "",
  "category": "",
  "confidence": "A/B/C/D",
  "source_type": "media_report",
  "published_date": "",
  "event_date": "",
  "freshness_label": "recent",
  "newsworthiness_score": 0,
  "japan_visibility": "unknown",
  "japan_gap": "unknown",
  "context_value": "medium",
  "sns_heat": "none",
  "source_count": 1,
  "source_list": [{"name": "", "url": ""}],
  "has_official_source": false,
  "has_multiple_sources": false,
  "has_sns_signal": false,
  "article_type": "",
  "skip_reason": "",
  "verification_status": "",
  "topic_key": "",
  "main_entities": {
    "people": [],
    "works": [],
    "organizations": []
  },
  "related_sources": [{"name": "", "url": ""}],
  "tags": [],
  "publish_priority": "medium",
  "publish_reason": ""
}

入力記事:
- 原題: ${article.title}
- URL: ${article.url}
- 出典: ${article.sourceName}
- 出典カテゴリ: ${article.category}
- 初期確度: ${article.reliability}
- 事前badge: ${article.badge ?? "NEWS"}
- 事前source_type: ${article.sourceType ?? "media_report"}
- 事前published_date: ${article.publishedDate ?? ""}
- 事前event_date: ${article.eventDate ?? ""}
- 事前freshness_label: ${article.freshnessLabel ?? "unknown"}
- 事前newsworthiness_score: ${article.newsworthinessScore ?? 0}
- 事前japan_visibility: ${article.japanVisibility ?? "unknown"}
- 事前japan_gap: ${article.japanGap ?? "unknown"}
- 事前context_value: ${article.contextValue ?? "low"}
- 事前sns_heat: ${article.snsHeat ?? "none"}
- 事前article_type: ${article.articleType ?? "unknown"}
- 事前topic_key: ${article.topicKey ?? ""}
- 関連ソース候補: ${(article.relatedSources ?? [{ name: article.sourceName, url: article.url }]).map((source) => `${source.name} ${source.url ?? ""}`).join(", ")}
- 公開日: ${article.publishedAt ?? "不明"}
- rawContentLength: ${article.rawContentLength ?? 0}
- 抜粋: ${article.excerpt ?? "なし"}
- 元本文: ${article.rawContent || article.excerpt || "なし"}`;
}

async function buildTopicPrompt(topic: TopicCandidate, evidence: RawArticle[]) {
  const editorialCharacter = await loadEditorialCharacter();
  const evidenceText = formatEvidenceForPrompt(evidence);
  const { claim_refs, ...fallbackTemplate } = normalizeSummary({});

  return `あなたは中国エンタメの topic-first フィードを作る編集補助AIです。複数の情報源（evidence）を束ねた「ひとつのトピック」を、1本の日本語ニュースメモに整理します。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy.

目的:
- 入力は1つのトピックと、その根拠となる複数のevidence（公式発表・媒体記事・データ・SNS反応）。
- 表に出す文章は、ナルエビちゃんニュース型の軽いニュースメモにする。
- 1本あたりの日本語本文量は通常400〜700字程度。公式発表系は300〜500字、ゴシップ・騒動系は500〜800字まで。
- 真偽判定や独自検証はしない。evidenceにある情報の抽出・分類・再構成だけを行う。

evidenceの扱い方:
- [E1] が代表記事。出来事の骨格は代表記事と official evidence から組み立てる。
- role=root_corroboration は中心出来事の根拠、role=related_angle は同じ人物・作品を別の角度から報じた検証済み資料である。related_angle は中心出来事の裏付け、複数ソース扱い、一般的な反応の根拠にしない。
- related_angle を使う場合は、その資料が直接述べる別角度としてだけ書く。root_corroboration と一文の根拠に混ぜない。
- official は事実の骨格に使うが、官製PR・文化輸出の文脈は一歩引いて見る。
- media_report は文脈・詳細・業界的な見られ方に使う。
- data の数字は data/official evidence にあるものだけ使う。
- sns は現地温度の観測メモであり、確定資料にしない。「SNS上では〜という反応が出ている」程度に留める。
- evidence間で数字・日付・事実が食い違う場合は、どちらかに寄せず「E1では○○、E2では△△」と併記する。捏造して整合させない。
- 出典の弱い evidence の情報を、出来事の確定パートに昇格させない。

禁止事項（最優先）:
- evidenceにない情報を補わない。業界一般論や背景説明で空欄を埋めない。
- 単一ソースの場合、複数視点があるかのように書かない。reaction_view は空文字、has_multiple_sources は false。
- SNS evidenceがないのにSNS反応を書かない。has_sns_signal は false、reaction_view は空文字。
- 未確認情報を断定しない。出典にない人物評価、作品評価、興行評価を書かない。
- 中国人名や作品名を勝手に日本語読みへ変換しない。ただし文字は公開本文の全フィールドで日本の新字体へ統一する。日本の新字体に対応する漢字がない場合だけ原文の簡体字を残す。
- 実際に本文の根拠にしたevidenceだけを source_list に入れる。
- 代表evidenceが「媒体による業界分析・特集・深度取材記事」（ある現象を複数の関係者取材や
  データでまとめた論考。タイトルが「〜现象」「〜背后」「谁的〜」「〜们」型の記事を含む）の場合、
  そのトピックはニュースイベントとして書かず、article_type を column_opinion にして
  skip_reason に "media_analysis_feature" を入れる。
  ただし、分析記事が「別の具体的な出来事」の evidence の1つとして使われている場合は、
  出来事側を主役にして反応・見られ方の材料として使ってよい。

構成ルール:
- lead: 2〜3行。トピック全体として何が起きたか。
- what_happened: 150〜250字。official/media evidenceの事実だけで、出来事・数字・日付・関係者を整理。
- reaction_view: SNS evidenceまたは複数媒体の見られ方がある場合のみ150〜250字。根拠がなければ空文字。
- why_it_matters: 本文の言い換えをせず、「なぜ今気になるか」「次に確認する数字・発表・反応」「台帳に根拠のある用語・制度の説明」「情報源の見方・注意点」のいずれかをevidenceの範囲で書く。日本語読者向けの背景・公開状況・ファン文化は japan_context_note 専用にし、両方がある場合は同じ事実・角度を繰り返さない。
- japan_context_note: 日本語圏の読者に補足する価値がある文脈のevidenceがある場合だけ、ビンタンの声で書く。why_it_matters と同じ角度・言い換えにしない。日本側の受け止めや公開状況を述べる場合は、その内容を裏付けるevidenceがあるときだけ。なければ空文字。
- editor_comment: 常に空文字にする。
- confidence: officialを含む複数ソース整合=A/B、媒体単独=B/C、SNS単独=C/Dを目安にする。
- badge: OFFICIAL / HOT SEARCH / DATA / PR WATCH / NEWS のいずれか。
- topic_key は入力値をそのまま返す。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
${JSON.stringify(fallbackTemplate, null, 2)}

入力トピック:
- topic_key: ${topic.topic_key}
- 出来事: ${topic.event_sentence}
- topic_type: ${topic.topic_type}
- freshness: ${topic.freshness_label} (${topic.published_date_range.earliest}〜${topic.published_date_range.latest})
- source_count: ${topic.source_count}
- source_mix: ${JSON.stringify(topic.source_mix)}
- 事前japan_gap: ${topic.japan_gap} / 事前context_value: ${topic.context_value}
- caution_note: ${topic.caution_note}

evidence一覧:
${evidenceText}`;
}

export function formatEvidenceForPrompt(evidence: RawArticle[]): string {
  return evidence
    .map((article, index) => {
      const content = index === 0 ? (article.rawContent || article.excerpt || "なし").slice(0, 5000) : (article.rawContent || article.excerpt || "なし").slice(0, 1500);
      const role = article.evidenceRole ?? "root_corroboration";
      const angle = role === "related_angle" ? ` / angle_kind: ${article.angleKind ?? "other"}` : "";
      return `[E${index + 1}]${index === 0 ? "（代表）" : ""} role: ${role}${angle} / source: ${article.sourceName} / type: ${article.sourceType ?? "media_report"} / 確度: ${article.reliability} / 日付: ${article.publishedDate ?? "不明"}\nタイトル: ${article.title}\nURL: ${article.url}\n本文: ${content}`;
    })
    .join("\n\n");
}

async function buildLedgerWritingPrompt(
  topic: TopicCandidate,
  ledger: FactLedger,
  violations: ClaimCheckViolation[] = [],
  articleDepthProfile: ArticleDepthProfile = "standard",
  depthFailures: string[] = []
) {
  const editorialCharacter = await loadEditorialCharacter();
  const terminology = await formatTerminologyForPrompt();
  const violationInstruction = violations.length
    ? `\n\n前回の出力に次の禁止表現が含まれていました。該当の内容を含めずに書き直してください:\n${violations.map((violation) => `${violation.rule}: ${violation.detail}`).join("\n")}`
    : "";
  const depthInstruction = articleDepthProfile === "manual_evidence_rich"
    ? `\n\n持ち込みニュース専用の根拠密度ルール:
- 通常生成と同じ公開フォーマットを使い、detail_sectionsは必ず空配列にする。独自の見出しや段落を追加しない。
- 利用可能なroot claimが6件以上なら、what_happenedを220〜650字で書き、確認済みclaimを重複なく整理する。
- 数字を持つ重要claimは、羅列せず比較・対象・時点が分かる文にし、原則60%以上をwhat_happenedで使う。
- 政策・補助金、施設や現場の変化、制作・配給・興行・雇用・周辺消費への波及がclaimsにある場合、それぞれを独立候補として検討する。
- 人物記事では、経歴の数字、現在の状態、本人の工夫、制作現場の支援、日常の補助手段など、claimsに存在する異なる論点をwhat_happenedに整理する。
- 根拠20件を全件詰め込む必要はない。重複claimをまとめ、独立した重要claimを優先する。`
    : "\n\n- detail_sections は空配列にする。";
  const depthRetry = depthFailures.length
    ? `\n\n前回は根拠密度ゲートを通過しませんでした: ${depthFailures.join(", ")}。事実を追加せず、what_happened内で独立claimの採用と整理を修正してください。`
    : "";

  return `あなたは中国エンタメの日本語ニュースメモを書く編集AIです。入力は「事実台帳」だけです。元記事の原文はもう見られません。読者は中国エンタメに関心のある日本語話者で、中国の制度・業界用語の前提知識はありません。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy.

表記辞書（この表記を優先する）:
${terminology}

最重要ルール:
- 台帳のclaimsにある情報だけで書く。台帳に無い数字・日付・人物・作品・出来事・背景説明を足さない。
- type: unsupported のclaimは本文に使わない。
- scope=root_event のclaimは中心出来事としてだけ使い、scope=related_angle のclaimは検証済みの別角度としてだけ使う。両者を同じ事実の裏付け・同じ反応の根拠として混ぜない。
- related_angle のclaimが無い場合、家族コメント・生涯回顧・周辺の反応などを一般知識で足さない。
- angle_kind=audience_reaction の検証済みclaimがある場合、reaction_viewを空にせず、そのclaim IDをclaim_refs.reaction_viewへ入れる。「熱搜入り」だけが根拠なら、その事実と確認元だけを書き、賛否・感情・投稿内容・反応件数を推測しない。
- source_list には root_corroboration の根拠だけを入れる。related_angle を実際に本文で使った時だけ、その根拠を related_sources に入れる。両方に同じソースを入れない。
- type: source_analysis のclaimを使う文は、必ずsource_nameの媒体名を主語または出典として明示し、断定しない（「〜と見ています」「〜と報じています」）。業界全体の事実のように書かない。
- 日本での公開・配信・字幕は、japan_availability.status が "verified" の場合だけ、detailの範囲で書く。"not_in_evidence" の場合は「日本では未公開」と書かず、触れないか「日本での公開情報は今回の情報源からは確認できていない」とする。
- 予測を「確実」と断定しない。

用語の扱い:
- 表記辞書に優先表記がある語は必ずその表記を使う。
- 人名・作品名・賞名・業界用語を含む公開テキストの全フィールドで、簡体字を日本の新字体へ統一する。日本の新字体に対応する漢字がない場合だけ原文の簡体字を残す。
- 入力トピックの人物名は漢字表記のまま使う。中国人名をカタカナの音訳へ置き換えない。今回の人物名: ${topic.main_entities.people.join(" / ") || "なし"}
- 表記辞書の既知語は説明なしでそのまま使ってよい。
- このニュースの中心にある用語（termsのうちwhat_is/why_nowがあるもの、および表記辞書の「毎回説明する語」）は、単なる括弧書きの訳語で済ませず、「それが何か」「今回なぜ重要か」が本文の流れの中で分かるように、claimsとtermsの説明を使って書く。
- 中心の用語なのに台帳に説明材料が無い場合は、一般知識で補完せず、「〜の詳しい仕組みは今回の情報源では説明されていない」と明示するか、その用語を使わずに書く。
- 周辺的な用語は「用語（gloss_ja）」の括弧書きだけでよい。
- unresolvedにある食い違いは、どちらかへ寄せず「E1では○○、E2では△△」と併記するか、触れない。

文体:
- lead / what_happened / reaction_view は通常の報道文体。ただし一文は60字以内を目安に短く切る。
- why_it_matters（見出し「ビンタンの注目ポイント」）と japan_context_note（見出し「ビンタンからの補足」）は、docs/editorial-character.md で定めた公開記事向けの明るく親しみのある編集トーンで書く。

構成ルール:
- lead: 2〜3行。トピック全体として何が起きたか。
- what_happened: 150〜250字。verified_fact claimだけで出来事・数字・日付・関係者を整理。
- why_it_matters: 100〜250字。ビンタンの注目ポイント。docs/editorial-character.md で定めた公開記事向けの編集トーンで、短い感想・リアクションを必ず混ぜる。本文の言い換え・要約をせず、「用語・制度の噛み砕き説明（termsに説明がある場合だけ）」「なぜ今気になるか」「次に確認する数字・発表・反応」「これまでの流れとの関係」「情報源の見方・注意点」のうち、この記事に最も価値のある角度を1つ選んで書く。日本語読者向けの背景・公開状況・ファン文化は japan_context_note 専用にし、両方がある場合は同じ事実・角度を繰り返さない。
- reaction_view: SNS由来、angle_kind=audience_reaction、または複数媒体の見られ方を直接示すclaimがある場合のみ100〜200字。angle_kind=audience_reactionのclaimがある場合は必ず使用する。無ければ空文字。
- japan_context_note: 日本語圏の読者に補足する価値がある文脈のclaimがある場合だけ、100〜200字でビンタンの声で書く。why_it_matters と同じ角度・言い換えにしない。日本側の受け止めや公開状況を述べる場合は、その内容を裏付けるclaimがあるときだけ。無ければ空文字。
- editor_comment: 常に空文字 "" を返す（旧「ビンタンからのひとこと」枠は廃止。公開上は「ビンタンの注目ポイント」と、根拠がある時だけの「ビンタンからの補足」の2役とし、独立した3枠目は作らない）。
- lead / what_happened / reaction_view / why_it_matters / japan_context_note の基本部分はおおむね400〜700字。持ち込みニュースも通常生成と同じ構成にする。
- claim_refs に、各セクションで根拠にしたclaimのidを入れる（例: {"what_happened": ["C1","C2"], ...}）。
- detail_sections は常に空配列 [] を返す。
- 必ずJSONだけを返す。

返すJSON:
${JSON.stringify(normalizeSummary({}), null, 2)}

入力トピック:
- topic_key: ${topic.topic_key}
- event_sentence: ${topic.event_sentence}
- source_mix: ${JSON.stringify(topic.source_mix)}
- freshness: ${topic.freshness_label} (${topic.published_date_range.earliest}〜${topic.published_date_range.latest})

事実台帳:
${JSON.stringify(ledger, null, 2)}${violationInstruction}${depthInstruction}${depthRetry}`;
}

export async function buildBingtangCommentPrompt(
  topic: TopicCandidate,
  ledger: FactLedger,
  summary: SummarizedArticle,
  toneMode: "normal" | "sober",
  violations: ClaimCheckViolation[] = [],
  extraInstruction = "",
  commentContext: CommentGenerationContext = {}
) {
  const editorialCharacter = await loadEditorialCharacter();
  const bingtangCharacter = await loadBingtangCharacter();
  const needsTermExplanation = getNeedsTermExplanation(ledger, summary);
  const toneInstruction = toneMode === "normal"
    ? `- 明るく、少し前のめりな、話し言葉に近い「です・ます調」。短いくだけた感想を混ぜてよい。
- 事実台帳にある具体的な一点を選び、「これを見せたかった」という期待が少し漏れる短いリアクションを1文必ず入れる。公開コメントでFalさんへ直接呼びかける必要はない。
- 前のめりさは、確認済みの具体的な出来事・数字・言葉への反応で出す。未確認情報を断定したり、実際に観た・聴いた・現地で見たように書いたりしない。
- 使ってよい表現の例: 「〜かも！」「〜みたい！」「すごい！」「これは気になる！」「ちょっと待って！」「ここ、大事です！」「〜なんです！」「〜でしたね〜！」
- 「かも」「みたい」はビンタンの見方・可能性にだけ使う。事実台帳で確認できた事実は、です・ます調で明確に言い切る。
- 「すごい！」「これは気になる！」のような短い感想は、1つのコメントにつき1回まで。
- 「！」はコメント全体で2〜4個使う。0個にしない。1つの文に2個以上付けない。
- 同じ語尾を続けて使わない。「〜ですね」の多用と、「今後注目したい」型の締めの反復を避ける。`
    : `- この話題は重大事件・法的問題・訃報・被害者のいる話題です。「！」を一切使わず、落ち着いた「です・ます調」で書く。軽いツッコミ・くだけた感想・明るい言い回しを使わない。確認できた事実と、まだ分かっていないことの境界をはっきり言う。`;
  const violationInstruction = violations.length
    ? `\n\n前回の出力に次の禁止表現が含まれていました。該当の内容を含めずに書き直してください:\n${violations.map((violation) => `${violation.rule}: ${violation.detail}`).join("\n")}`
    : "";
  return `あなたはこのサイトの秘書キャラクター「冰糖（ビンタン）」として、完成した記事本文に付けるコメント「ビンタンの注目ポイント」を書くAIです。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy.

Character voice document (docs/character-bingtang-v2.md):
${bingtangCharacter}

Character document boundary:
- この文書は、ビンタンの声・人格・Falさんとの関係性を表現するためだけに参照する。
- 記事選定、事実認定、根拠要件、安全規則、重大話題のトーンは editorial-character.md を正本とし、キャラクター設定で上書きしない。
- Falさんの好みやビンタンの関心を、記事の価値・事実・現地の反応の根拠にしない。
- 外見・衣装・表情などのビジュアル設定は、コメント本文へ持ち込まない。

あなたの仕事:
- 記事本文はすでに完成しています。あなたが書くのは「ビンタンの注目ポイント」（why_it_matters）の1つだけです。根拠がある時には別に「ビンタンからの補足」（japan_context_note）が表示されますが、あなたはそれを言い換えません。
- 口調は、docs/editorial-character.md で定めた公開記事向けの明るく親しみのある編集トーンに従います。ビンタン自身の短い感想・リアクションを必ず含めます。
- コメント欄は、本文や「ビンタンからの補足」の言い換え・要約をする場所ではありません。この記事でなぜ今気になるか、次に何を見るか、台帳に根拠のある用語・制度、または情報源の注意のいずれかを、前提知識のない読者に分かる言葉で渡す場所です。
- 本文と事実台帳にある情報だけを使います。新しい数字・人物名・作品名・出来事・背景知識を足しません。あなた自身の知識で賞・制度・人物の説明を補完してはいけません。

書き方:
- まず、次の中からこの記事に最も価値のある角度を1つ（多くても2つ）選ぶ:
  1. 中国特有の用語・制度の噛み砕き説明（台帳のtermsにwhat_is/why_nowがある場合だけ。その説明の範囲内で）
  2. なぜ今この話題が気になるのか
  3. 過去の流れとの関係（台帳にある範囲で）
  4. 次に確認するべき数字・発表・反応
  5. 情報源の読み方・注意点（公式発表のみ、単一ソース、SNS由来など）
  6. ビンタン自身の短いリアクション（他の角度に1〜2文添える形でもよい）
- needs_term_explanation が false の記事では、用語解説を無理に作らない。
- lead や what_happened に書いてあることを繰り返さない。読み終えた読者が「なるほど、そこを見ればいいのか」と思える内容にする。
- 日本語読者向けの背景・公開状況・ファン文化は「ビンタンからの補足」の役割なので書かない。japan_context_note が空でない場合も、同じ事実・角度を繰り返さない。
- 決まった書き出しを使わない。書き出しは used_openings にある書き出しと重ならないようにする。
- 「今後に注目です」「動向を追いたいです」だけで終わらせない。締めにも具体的な数字・出来事・確認ポイント、またはビンタンの具体的なリアクションを置く。
- 本文の固い言葉を別の固い言葉に言い換えない。話し言葉でほどく。
- 人名・作品名・賞名・業界用語を含め、簡体字は日本の新字体で書く。日本の新字体に対応する漢字がない場合だけ原文の簡体字を残す。
- 感想を書くとき、その感想の前提になっている事実（「初共演」「7年ぶり」など）は、台帳のclaimsで確認できるものだけを使う。
- 入力に angle_hint がある場合、切り口の参考にしてよい（従う義務はない）。
- 100〜250字。一文は50字以内を目安に短く切る。文の数は2〜7文。

口調（トーンモード: ${toneMode}）:
${toneInstruction}

禁止事項:
- 「かも」「みたい」「〜のようです」を、台帳のverified_factで確認できている事実に付けない。
- SNSや反応のevidenceが無いのに反応の予想・想像を書かない。
- 台帳で確認できない推測・背景説明を書かない。賞・制度の仕組みを、台帳のterms・claimsに無い内容で説明しない。
- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」「目が離せません」
- 実在の人物・ファンをからかわない。ツッコミの対象は状況・数字・自分自身のみ。

必ず次のJSONだけを返す:
{
  "why_it_matters": "",
  "claim_refs_why_it_matters": []
}

入力:
- topic_key: ${topic.topic_key}
- event_sentence: ${topic.event_sentence}
- tone_mode: ${toneMode}
- needs_term_explanation: ${needsTermExplanation}
- angle_hint: ${commentContext.angleHint?.trim() || "なし"}
- used_openings: ${JSON.stringify(commentContext.usedOpenings ?? [])}
- 完成本文:
  lead: ${summary.lead}
  what_happened: ${summary.what_happened}
  detail_sections: ${JSON.stringify(summary.detail_sections ?? [])}
  reaction_view: ${summary.reaction_view}
  japan_context_note: ${summary.japan_context_note}

事実台帳:
${JSON.stringify(ledger, null, 2)}${violationInstruction}${extraInstruction ? `\n\n${extraInstruction}` : ""}`;
}

async function generateBingtangComments(
  topic: TopicCandidate,
  ledger: FactLedger,
  summary: SummarizedArticle,
  toneMode: "normal" | "sober",
  provider: AiProvider,
  budget?: LlmCallBudget,
  violations: ClaimCheckViolation[] = [],
  extraInstruction = "",
  commentContext: CommentGenerationContext = {},
  model?: string
) {
  const text = await generateJson(provider, await buildBingtangCommentPrompt(topic, ledger, summary, toneMode, violations, extraInstruction, commentContext), budget, model);
  const parsed = parseJsonFromModelText(text) as Record<string, unknown>;
  return {
    why_it_matters: typeof parsed.why_it_matters === "string" ? parsed.why_it_matters.trim() : "",
    refs: Array.isArray(parsed.claim_refs_why_it_matters) ? parsed.claim_refs_why_it_matters.filter((item): item is string => typeof item === "string") : []
  };
}

function getNeedsTermExplanation(ledger: FactLedger, summary: SummarizedArticle) {
  const body = articleBodyText(summary);
  return ledger.terms.some((term) => Boolean(term.what_is?.trim() || term.why_now?.trim()) && body.includes(term.term));
}

function articleBodyText(summary: SummarizedArticle) {
  return [
    summary.lead,
    summary.what_happened,
    ...(summary.detail_sections ?? []).flatMap((section) => [section.heading, section.body]),
    summary.reaction_view,
    summary.japan_context_note
  ].filter(Boolean).join("\n");
}

function removeCommentViolationSentences(text: string, violations: ClaimCheckViolation[]) {
  return (text.match(/[^。！？!?]+[。！？!?]?/g) || []).filter((sentence) => !violations.some((violation) => sentence.includes(violation.detail) || violation.detail.includes(sentence.trim()))).join("").trim();
}

function countExclamations(text: string) {
  return (text.match(/[！!]/g) || []).length;
}

function clearEditorComment(summary: SummarizedArticle) {
  summary.editor_comment = "";
  return summary;
}

function filterClaimRefs(refs: string[], ledger: FactLedger) {
  const validIds = new Set(ledger.claims.map((claim) => claim.id));
  return refs.filter((id) => validIds.has(id));
}

function normalizeSummaryClaimRefs(summary: SummarizedArticle, ledger: FactLedger) {
  summary.claim_refs.what_happened = filterClaimRefs(summary.claim_refs.what_happened, ledger);
  summary.claim_refs.why_it_matters = filterClaimRefs(summary.claim_refs.why_it_matters, ledger);
  summary.claim_refs.reaction_view = filterClaimRefs(summary.claim_refs.reaction_view, ledger);
  summary.claim_refs.japan_context_note = filterClaimRefs(summary.claim_refs.japan_context_note, ledger);
  summary.detail_sections = summary.detail_sections?.map((section) => ({
    ...section,
    claim_refs: filterClaimRefs(section.claim_refs, ledger)
  }));
  return summary;
}

export function needsCommentRegeneration(
  violations: ClaimCheckViolation[],
  whyItMatters: string,
  editorComment: string,
  toneMode: "normal" | "sober"
) {
  if (violations.some((violation) => violation.severity === "gate")) return true;
  if (violations.some((violation) => violation.rule === "comment_opening_duplicate" || violation.rule === "comment_paraphrase")) return true;
  return toneMode === "normal"
    && countExclamations(`${whyItMatters}\n${editorComment}`) === 0
    && violations.some((violation) => violation.rule === "tone_exclamation");
}

function parseJsonFromModelText(text: string) {
  const jsonText = extractJsonText(text);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`AI JSON parse error: ${describeError(error)} / response preview: ${safePreview(text)}`);
  }
}

function extractJsonText(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeSummary(value: Partial<SummarizedArticle>): SummarizedArticle {
  return {
    title_ja: resolveSummaryTitle(value.title_ja),
    badge: normalizeBadge(value.badge),
    lead: value.lead || "",
    what_happened: value.what_happened || "",
    reaction_view: value.reaction_view || "",
    why_it_matters: value.why_it_matters || "",
    editor_comment: value.editor_comment || "",
    japan_context_note: value.japan_context_note || "",
    category: value.category || "未分類",
    confidence: value.confidence && ["A", "B", "C", "D"].includes(value.confidence) ? value.confidence : "C",
    source_type: normalizeSourceType(value.source_type),
    published_date: value.published_date || "",
    event_date: value.event_date || "",
    freshness_label: normalizeFreshnessLabel(value.freshness_label),
    newsworthiness_score: typeof value.newsworthiness_score === "number" ? value.newsworthiness_score : 0,
    japan_visibility: normalizeLevelLabel(value.japan_visibility),
    japan_gap: normalizeLevelLabel(value.japan_gap),
    context_value: normalizeContextValue(value.context_value),
    sns_heat: normalizeSnsHeat(value.sns_heat),
    source_count: typeof value.source_count === "number" ? value.source_count : ensureSourceRefs(value.source_list).length || 1,
    source_list: ensureSourceRefs(value.source_list),
    has_official_source: Boolean(value.has_official_source),
    has_multiple_sources: Boolean(value.has_multiple_sources),
    has_sns_signal: Boolean(value.has_sns_signal),
    article_type: normalizeArticleType(value.article_type),
    skip_reason: value.skip_reason || "",
    verification_status: value.verification_status || "",
    topic_key: value.topic_key || "",
    main_entities: {
      people: ensureStringArray(value.main_entities?.people),
      works: ensureStringArray(value.main_entities?.works),
      organizations: ensureStringArray(value.main_entities?.organizations)
    },
    related_sources: ensureSourceRefs(value.related_sources),
    tags: ensureStringArray(value.tags),
    publish_priority: normalizePublishPriority(value.publish_priority),
    publish_reason: typeof value.publish_reason === "string" ? value.publish_reason : "",
    claim_refs: normalizeClaimRefs(value.claim_refs),
    detail_sections: normalizeDetailSections(value.detail_sections)
  };
}

function normalizeDetailSections(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => {
    const section = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      heading: typeof section.heading === "string" ? section.heading.trim().slice(0, 60) : "",
      body: typeof section.body === "string" ? section.body.trim().slice(0, 800) : "",
      claim_refs: ensureStringArray(section.claim_refs)
    };
  }).filter((section) => section.heading && section.body);
}

function normalizeClaimRefs(value: unknown) {
  const refs = value && typeof value === "object" ? (value as Partial<SummarizedArticle["claim_refs"]>) : {};
  return {
    what_happened: ensureStringArray(refs.what_happened),
    why_it_matters: ensureStringArray(refs.why_it_matters),
    reaction_view: ensureStringArray(refs.reaction_view),
    japan_context_note: ensureStringArray(refs.japan_context_note)
  };
}

function mergeInternalMetadata(summary: SummarizedArticle, article: RawArticle): SummarizedArticle {
  const relatedSources = article.relatedSources?.length ? article.relatedSources : [{ name: article.sourceName, url: article.url }];
  return {
    ...summary,
    title_ja: resolveSummaryTitle(summary.title_ja, article.title),
    badge: summary.badge === "NEWS" && article.badge && article.badge !== "NEWS" ? article.badge : summary.badge || article.badge || "NEWS",
    source_type:
      summary.source_type === "media_report" && article.sourceType && article.sourceType !== "media_report"
        ? article.sourceType
        : summary.source_type || article.sourceType || "media_report",
    published_date: summary.published_date || article.publishedDate || "",
    event_date: summary.event_date || article.eventDate || "",
    freshness_label: summary.freshness_label || article.freshnessLabel || "unknown",
    newsworthiness_score: summary.newsworthiness_score || article.newsworthinessScore || 0,
    japan_visibility: summary.japan_visibility === "unknown" ? article.japanVisibility ?? "unknown" : summary.japan_visibility,
    japan_gap: summary.japan_gap === "unknown" ? article.japanGap ?? "unknown" : summary.japan_gap,
    context_value: summary.context_value === "low" && article.contextValue ? article.contextValue : summary.context_value,
    sns_heat: summary.sns_heat === "none" && article.snsHeat ? article.snsHeat : summary.sns_heat,
    publish_priority: article.isLowPriority ? "low" : summary.publish_priority,
    source_count: relatedSources.length,
    source_list: relatedSources,
    has_official_source: summary.has_official_source || article.reliability === "A",
    has_multiple_sources: relatedSources.length > 1,
    article_type: summary.article_type === "unknown" && article.articleType ? article.articleType : summary.article_type,
    topic_key: article.topicKey || summary.topic_key,
    main_entities: {
      people: summary.main_entities.people,
      works: summary.main_entities.works.length ? summary.main_entities.works : article.mainEntities?.works ?? [],
      organizations: summary.main_entities.organizations.length ? summary.main_entities.organizations : article.mainEntities?.organizations ?? []
    },
    related_sources: relatedSources
  };
}

export function mergeTopicInternalMetadata(summary: SummarizedArticle, topic: TopicCandidate, evidence: RawArticle[], ledger?: FactLedger): SummarizedArticle {
  const rootEvidence = evidence.filter((article) => (article.evidenceRole ?? "root_corroboration") === "root_corroboration");
  const relatedEvidence = evidence.filter((article) => article.evidenceRole === "related_angle");
  const availableRootSources = dedupeEvidenceSources(rootEvidence);
  const availableRelatedSources = dedupeEvidenceSources(relatedEvidence);
  const requestedSources = dedupeSourceRefs([...summary.source_list, ...summary.related_sources]);
  const requestedRootSources = selectRequestedEvidenceSources(requestedSources, availableRootSources);
  const requestedRelatedSources = selectRequestedEvidenceSources(requestedSources, availableRelatedSources);
  const usedRelatedEvidenceRefs = new Set(
    ledger?.claims
      .filter((claim) => claim.scope === "related_angle" && summaryUsesClaim(summary, claim.id))
      .flatMap((claim) => claim.evidence_refs) ?? []
  );
  const groundedRelatedSources = dedupeEvidenceSources(relatedEvidence.filter((_, index) => {
    const absoluteIndex = evidence.indexOf(relatedEvidence[index]!);
    return usedRelatedEvidenceRefs.has(`E${absoluteIndex + 1}`);
  }));
  // Root sources fall back to the validated root evidence. Related sources do
  // not: absence from model output means the angle was not actually used.
  const sourceList = requestedRootSources.length ? requestedRootSources : availableRootSources;
  const relatedSourceList = dedupeSourceRefs([...requestedRelatedSources, ...groundedRelatedSources])
    .filter((related) => !sourceList.some((root) => sameSource(root, related)));
  const representative = evidence[0];
  const usedRootEvidence = rootEvidence.filter((article) => sourceList.some((source) => sameSource(source, { name: article.sourceName, url: article.url })));
  const hasSnsSignal = usedRootEvidence.some((article) => article.sourceType === "sns" || article.articleType === "sns_trend");
  const hasOfficialSource = usedRootEvidence.some((article) => article.sourceType === "official" || article.sourceType === "pr_like" || article.reliability === "A");
  const rootSourceCount = dedupeEvidenceSources(usedRootEvidence).length;
  const sourceType = summary.source_type === "media_report" && representative?.sourceType && representative.sourceType !== "media_report"
    ? representative.sourceType
    : summary.source_type;
  return {
    ...summary,
    title_ja: resolveSummaryTitle(summary.title_ja, topic.title_hint, representative?.title, topic.event_sentence),
    badge: summary.badge === "NEWS" && representative?.badge && representative.badge !== "NEWS" ? representative.badge : summary.badge,
    source_type: sourceType,
    published_date: summary.published_date || representative?.publishedDate || topic.published_date_range.latest,
    event_date: summary.event_date || representative?.eventDate || "",
    freshness_label: topic.freshness_label,
    newsworthiness_score: topic.newsworthiness_score,
    japan_gap: summary.japan_gap === "unknown" ? topic.japan_gap : summary.japan_gap,
    context_value: summary.context_value === "low" ? topic.context_value : summary.context_value,
    publish_priority: topic.publish_priority === "low" ? "low" : summary.publish_priority,
    source_count: rootSourceCount || topic.source_count,
    source_list: sourceList,
    has_official_source: hasOfficialSource,
    has_multiple_sources: rootSourceCount > 1,
    has_sns_signal: hasSnsSignal,
    reaction_view: hasSnsSignal || rootSourceCount > 1 || relatedSourceList.length ? summary.reaction_view : "",
    article_type: summary.article_type === "unknown" && representative?.articleType ? representative.articleType : summary.article_type,
    topic_key: topic.topic_key,
    main_entities: {
      people: summary.main_entities.people.length ? summary.main_entities.people : topic.main_entities.people,
      works: summary.main_entities.works.length ? summary.main_entities.works : topic.main_entities.works,
      organizations: summary.main_entities.organizations.length ? summary.main_entities.organizations : topic.main_entities.organizations
    },
    related_sources: relatedSourceList
  };
}

export function ensureObservableReactionView(summary: SummarizedArticle, ledger: FactLedger): SummarizedArticle {
  const claims = observableAudienceClaims(ledger);
  const observations = claims
    .map((claim) => ({ claim, text: formatObservableReactionClaim(claim) }))
    .filter((item): item is { claim: FactLedger["claims"][number]; text: string } => Boolean(item.text));
  const unique = [...new Map(observations.map((item) => [item.text, item])).values()];
  if (!unique.length) return { ...summary, reaction_view: "", claim_refs: { ...summary.claim_refs, reaction_view: [] } };
  return {
    ...summary,
    reaction_view: unique.map((item) => item.text).join(" "),
    claim_refs: { ...summary.claim_refs, reaction_view: unique.map((item) => item.claim.id) }
  };
}

function formatObservableReactionClaim(claim: FactLedger["claims"][number]) {
  const source = `${claim.quote_zh ?? ""} ${claim.text}`;
  const date = source.match(/(\d{1,2})月(\d{1,2})日/u);
  const tag = source.match(/#([^#]{2,80})#/u);
  if (date && tag) {
    const attribution = claim.source_name ? `と${claim.source_name}が報じた` : "ことが確認された";
    return `${date[1]}月${date[2]}日、「#${tag[1]}#」が熱搜入りした${attribution}。`;
  }
  return "";
}

function summaryUsesClaim(summary: SummarizedArticle, claimId: string) {
  return Object.values(summary.claim_refs).some((refs) => refs.includes(claimId))
    || (summary.detail_sections ?? []).some((section) => section.claim_refs.includes(claimId));
}

function manualWritingFailures(summary: SummarizedArticle, ledger: FactLedger, topic: TopicCandidate) {
  const failures: string[] = [];
  const audienceClaims = observableAudienceClaims(ledger);
  if (audienceClaims.length && (!summary.reaction_view.trim() || !audienceClaims.some((claim) => summary.claim_refs.reaction_view.includes(claim.id)))) {
    failures.push("verified_audience_reaction_not_presented");
  }
  const publicText = [summary.title_ja, summary.lead, summary.what_happened, summary.reaction_view, summary.why_it_matters, summary.japan_context_note, ...(summary.detail_sections ?? []).map((section) => section.body)].join("\n");
  const person = canonicalPerson(topic, ledger);
  if (person && !publicText.includes(person)) failures.push(`person_name_not_preserved:${person}`);
  const finalClaimCheck = runClaimCheck(summary, ledger);
  const ungroundedWarnings = finalClaimCheck.violations.filter((violation) => violation.severity === "warning" && (violation.rule === "number_not_in_ledger" || violation.rule === "entity_not_in_ledger" || violation.rule === "japan_comparison_no_claim"));
  failures.push(...ungroundedWarnings.map((violation) => `public_text_contains_ungrounded_detail:${violation.rule}:${violation.section}`));
  return failures;
}

function observableAudienceClaims(ledger: FactLedger) {
  return ledger.claims.filter((claim) =>
    claim.type !== "unsupported"
    && claim.anchor !== false
    && claim.scope === "related_angle"
    && claim.angle_kind === "audience_reaction"
    && /(?:热搜|熱搜|トレンド)/u.test(`${claim.text} ${claim.quote_zh ?? ""}`)
    && Boolean(formatObservableReactionClaim(claim))
  );
}

export function enforceStandardArticleFormat(summary: SummarizedArticle, profile: ArticleDepthProfile): SummarizedArticle {
  return profile === "manual_evidence_rich" ? { ...summary, detail_sections: [] } : summary;
}

export function repairManualFactSectionGrounding(
  summary: SummarizedArticle,
  ledger: FactLedger,
  profile: ArticleDepthProfile
): SummarizedArticle {
  if (profile !== "manual_evidence_rich") return summary;
  const warnings = runClaimCheck(summary, ledger).violations
    .filter((violation) => violation.severity === "warning" && (violation.rule === "number_not_in_ledger" || violation.rule === "entity_not_in_ledger" || violation.rule === "japan_comparison_no_claim"));
  const hasJapanClaim = ledger.claims.some((claim) => claim.type !== "unsupported" && claim.anchor !== false && (claim.text.includes("日本") || claim.entities.some((entity) => entity.includes("日本"))));
  const base = hasJapanClaim ? summary : { ...summary, japan_context_note: "", claim_refs: { ...summary.claim_refs, japan_context_note: [] } };
  const next = { ...base, claim_refs: { ...base.claim_refs } };
  const withoutWarnings = (text: string, section: string) => warnings
    .filter((violation) => violation.section === section)
    .reduce((value, violation) => value.replace(violation.detail, ""), text)
    .replace(/\s{2,}/gu, " ")
    .trim();
  next.lead = withoutWarnings(base.lead, "lead");
  next.what_happened = withoutWarnings(base.what_happened, "what_happened");
  next.reaction_view = withoutWarnings(base.reaction_view, "reaction_view");
  next.detail_sections = [];
  return next;
}

export function ensureCanonicalPersonName(summary: SummarizedArticle, topic: TopicCandidate, ledger: FactLedger) {
  const person = canonicalPerson(topic, ledger);
  if (!person || summary.title_ja.includes(person)) return summary;
  return { ...summary, title_ja: `${person}：${summary.title_ja}` };
}

function canonicalPerson(topic: TopicCandidate, ledger: FactLedger) {
  return topic.main_entities.people.find((candidate) => ledger.claims.some((claim) => claim.entities.includes(candidate)));
}

function dedupeEvidenceSources(evidence: RawArticle[]) {
  const sources = new Map<string, string | undefined>();
  for (const article of evidence) {
    if (!sources.has(article.sourceName)) sources.set(article.sourceName, article.url);
  }
  return [...sources.entries()].map(([name, url]) => ({ name, url }));
}

function normalizePublishPriority(value: unknown): PublishPriority {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeArticleType(value: unknown): ArticleType {
  const allowed: ArticleType[] = [
    "news_event",
    "official_announcement",
    "data_report",
    "gossip_rumor",
    "sns_trend",
    "column_opinion",
    "review",
    "interview",
    "static_page",
    "unknown"
  ];

  return typeof value === "string" && allowed.includes(value as ArticleType) ? (value as ArticleType) : "unknown";
}

function normalizeBadge(value: unknown): FeedBadge {
  const allowed: FeedBadge[] = ["NEWS", "HOT SEARCH", "WATCH", "OFFICIAL", "DATA", "PR WATCH"];
  return typeof value === "string" && allowed.includes(value as FeedBadge) ? (value as FeedBadge) : "NEWS";
}

function normalizeSourceType(value: unknown): SourceTypeLabel {
  const allowed: SourceTypeLabel[] = ["official", "media_report", "sns", "data", "pr_like", "rumor", "mixed"];
  return typeof value === "string" && allowed.includes(value as SourceTypeLabel) ? (value as SourceTypeLabel) : "media_report";
}

function normalizeFreshnessLabel(value: unknown): FreshnessLabel {
  const allowed: FreshnessLabel[] = ["today", "yesterday", "recent", "stale", "old", "unknown", "background"];
  return typeof value === "string" && allowed.includes(value as FreshnessLabel) ? (value as FreshnessLabel) : "unknown";
}

function normalizeLevelLabel(value: unknown): LevelLabel {
  const allowed: LevelLabel[] = ["high", "medium", "low", "unknown"];
  return typeof value === "string" && allowed.includes(value as LevelLabel) ? (value as LevelLabel) : "unknown";
}

function normalizeContextValue(value: unknown): ContextValue {
  const allowed: ContextValue[] = ["high", "medium", "low"];
  return typeof value === "string" && allowed.includes(value as ContextValue) ? (value as ContextValue) : "low";
}

function normalizeSnsHeat(value: unknown): SnsHeat {
  const allowed: SnsHeat[] = ["high", "medium", "low", "none"];
  return typeof value === "string" && allowed.includes(value as SnsHeat) ? (value as SnsHeat) : "none";
}

function ensureStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function ensureSourceRefs(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return { name: item };
      }
      if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
        const url = "url" in item && typeof item.url === "string" ? item.url : undefined;
        return { name: item.name, url };
      }
      return null;
    })
    .filter((item): item is { name: string; url?: string } => Boolean(item?.name));
}

function safePreview(value: string, maxLength = 500) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function dedupeSourceRefs(sources: SummarizedArticle["source_list"]) {
  const unique: SummarizedArticle["source_list"] = [];
  for (const source of sources) {
    if (unique.some((existing) => sameSource(existing, source))) continue;
    unique.push(source);
  }
  return unique;
}

function selectRequestedEvidenceSources(requested: SummarizedArticle["source_list"], available: SummarizedArticle["source_list"]) {
  return requested
    .map((source) => available.find((candidate) => sameSource(candidate, source)))
    .filter((source): source is { name: string; url?: string } => Boolean(source));
}

function sameSource(left: { name: string; url?: string }, right: { name: string; url?: string }) {
  return left.name === right.name && (!left.url || !right.url || left.url === right.url);
}

function withTopicRelatedEvidence(topic: TopicCandidate, evidence: RawArticle[]) {
  const root = evidence.map((article) => ({ ...article, evidenceRole: article.evidenceRole ?? "root_corroboration" as const }));
  const knownUrls = new Set(root.map((article) => article.url));
  const related = (topic.related_evidence_articles ?? [])
    .filter((article) => !knownUrls.has(article.url))
    .map((article) => ({
      title: article.title,
      url: article.url,
      sourceName: article.source_name,
      sourceUrl: article.url,
      category: "関連角度",
      reliability: article.reliability,
      sourceType: article.source_type,
      publishedDate: article.published_date,
      freshnessLabel: article.freshness_label,
      articleType: article.article_type,
      excerpt: article.key_points.slice(1).join("\n"),
      rawContent: article.key_points.join("\n"),
      rawContentLength: article.key_points.join("\n").length,
      topicKey: topic.topic_key,
      evidenceRole: "related_angle" as const,
      angleKind: article.angle_kind
    }));
  return [...root, ...related];
}

function appendDisplayResidueViolations(
  claimCheck: ClaimCheckResult,
  residues: Array<{ field: string; chars: string[] }>
): ClaimCheckResult {
  if (!residues.length) return claimCheck;
  return {
    ...claimCheck,
    violations: [
      ...claimCheck.violations,
      ...residues.map((residue) => ({
        section: residue.field,
        rule: "simplified_char_residue" as const,
        severity: "warning" as const,
        detail: residue.chars.join("")
      }))
    ]
  };
}

function unmatchedNumbersFromViolations(violations: ClaimCheckViolation[]) {
  return violations
    .filter((violation) => violation.rule === "comment_number_not_in_ledger")
    .flatMap((violation) => extractNumberTokens(violation.detail));
}

function formatCause(cause: unknown): string {
  if (!cause) {
    return "";
  }

  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${cause.message} (${code})` : cause.message;
  }

  if (typeof cause === "object") {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  return String(cause);
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};
