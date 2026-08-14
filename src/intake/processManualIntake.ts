import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ClaimCheckDiscardError } from "../claimCheck.js";
import { ArticleDepthGateError } from "../articleDepth.js";
import { classifyArticle, loadFilterConfig } from "../classifyArticle.js";
import { assessExtractionQuality } from "../evidence/documentSnapshot.js";
import { attachExpansionEvidence, expandTopicSources } from "../expandSources.js";
import { LedgerAdequacyGateError } from "../ledgerAdequacy.js";
import { createReviewStateFromStoredArticles, writeReviewState } from "../review/reviewState.js";
import { getAiProvider, summarizeTopic } from "../summarizeWithGemini.js";
import { extractTopicSeeds } from "../topicSeeds.js";
import { buildTopicCandidates } from "../topicCandidates.js";
import type { AiProvider, FactLedger, ProcessedArticle, RawArticle, SourceExpansionResult, TopicCandidate, TopicGenerationMeta } from "../types.js";
import { buildManualReviewIssue } from "./buildManualReviewIssue.js";
import { fetchIntakeDocument, redactIntakeUrl, type IntakeDocument, type IntakeFetchOptions } from "./fetchIntakeDocument.js";
import { parseManualIntake, type ManualIntakeComment } from "./parseManualIntake.js";
import {
  getManualIntakeDirectory,
  readManualIntakeState,
  updateManualIntakeState,
  writeManualIntakeArtifact,
  writeManualIntakeState,
  writeManualIntakeTextArtifact,
  type ManualIntakeState
} from "./intakeState.js";

export type ProcessManualIntakeOptions = {
  comment: ManualIntakeComment;
  dataRoot?: string;
  provider?: AiProvider;
  fetchOptions?: IntakeFetchOptions;
};

export type ManualIntakeProcessResult =
  | { ok: true; idempotent: boolean; commentId: string; directory: string; reviewBodyPath: string; reviewIssueNumber: number }
  | { ok: false; commentId: string; error: string };

type ManualIntakeProcessingStage = "initializing" | "fetching" | "topic_seed" | "researching" | "generating" | "persisting";

/**
 * Runs the isolated, immediate route. It deliberately does not call daily
 * persistence, site building, or publication: a review decision remains the
 * only path from this directory to public data.
 */
export async function processManualIntake(options: ProcessManualIntakeOptions): Promise<ManualIntakeProcessResult> {
  const parsed = parseManualIntake(options.comment);
  if (!parsed.accepted || !parsed.url) return { ok: false, commentId: parsed.commentId, error: parsed.error ?? "invalid_intake" };
  const dataRoot = options.dataRoot ?? "data";
  const directory = getManualIntakeDirectory(parsed.commentId, dataRoot);
  const existing = await readManualIntakeState(parsed.commentId, dataRoot);
  if (existing?.status === "review_ready" || existing?.status === "published") {
    return { ok: true, idempotent: true, commentId: parsed.commentId, directory, reviewBodyPath: `${directory}/review-issue.md`, reviewIssueNumber: existing.review_issue_number ?? 0 };
  }

  const persistedUrl = redactIntakeUrl(parsed.url);
  let state = existing ?? createInitialState(parsed.commentId, persistedUrl, parsed.note);
  let processingStage: ManualIntakeProcessingStage = "initializing";
  try {
    if (!existing) await writeManualIntakeState(state, dataRoot);
    await writeManualIntakeArtifact(parsed.commentId, "intake.json", {
      comment_id: parsed.commentId,
      author_login: options.comment.authorLogin,
      author_association: options.comment.authorAssociation,
      source_url: persistedUrl,
      note: parsed.note,
      received_at: state.created_at
    }, dataRoot);

    processingStage = "fetching";
    state = await updateManualIntakeState(state, { status: "fetching", error: "" }, dataRoot);
    const fetched = await fetchIntakeDocument(parsed.url, options.fetchOptions);
    const reused = !fetched.ok && (fetched.error === "fetch_timeout" || fetched.error === "fetch_failed")
      ? await findRecentIntakeDocument(persistedUrl, parsed.commentId, dataRoot)
      : undefined;
    if (!fetched.ok && !reused) throw new Error(`fetch:${fetched.error}`);
    const document = fetched.ok ? fetched.document : reused!.document;
    await writeManualIntakeArtifact(parsed.commentId, "document.json", {
      ...document,
      ...(reused ? { reused_from_comment_id: reused.commentId } : {})
    }, dataRoot);

    const filterConfig = await loadFilterConfig();
    const root = classifyArticle({
      title: document.title || parsed.url,
      url: document.final_url,
      sourceName: new URL(document.final_url).hostname,
      sourceUrl: document.final_url,
      category: "持ち込みニュース",
      reliability: "C",
      declaredSourceType: "media_report",
      publishedAt: document.published_date || undefined,
      publishedAtSource: document.published_date ? "html" : undefined,
      excerpt: document.text.slice(0, 1000),
      rawContent: document.text,
      rawContentLength: document.text.length
    }, filterConfig);
    processingStage = "topic_seed";
    const provider = options.provider ?? getAiProvider();
    const seeds = await extractTopicSeeds([root], provider);
    const initialTopic = buildTopicCandidates([root], seeds.seeds)[0];
    if (!initialTopic) throw new Error("topic:unable_to_build_candidate");

    processingStage = "researching";
    state = await updateManualIntakeState(state, { status: "researching", error: "" }, dataRoot);
    const researchTopic = buildManualResearchTopic(initialTopic, root);
    let research = await expandManualTopic(researchTopic);
    if (!verifiedCorroborationEvidence(research.expansion).length) {
      const cachedExpansion = await findRecentVerifiedExpansion(persistedUrl, parsed.commentId, dataRoot);
      if (cachedExpansion) {
        const reusedEvidence = cachedExpansion.expansion.evidence.map((item) => ({ ...item, validation_reason: "reused_verified_document" }));
        research = {
          topic: attachExpansionEvidence(research.topic, reusedEvidence),
          expansion: mergeCachedExpansion(research.expansion, reusedEvidence, cachedExpansion.commentId)
        };
      }
    }
    const topic = preserveManualIntakeRootEvidence(initialTopic, research.topic);
    const evidence = collectEvidence(root, topic);
    await writeManualIntakeArtifact(parsed.commentId, "topic.json", topic, dataRoot);
    await writeManualIntakeArtifact(parsed.commentId, "expansion.json", research.expansion, dataRoot);
    const evidenceAdequacy = assessManualEvidenceAdequacy(document, research.expansion);
    await writeManualIntakeArtifact(parsed.commentId, "evidence-adequacy.json", evidenceAdequacy, dataRoot);
    if (!evidenceAdequacy.passed) throw new Error(`evidence_adequacy_gate:${evidenceAdequacy.reasons.join("|")}`);

    processingStage = "generating";
    state = await updateManualIntakeState(state, { status: "generating", error: "" }, dataRoot);
    const generated = await summarizeTopic(topic, evidence, provider, undefined, { articleDepthProfile: "manual_evidence_rich" });
    // The persisted ledger, claim refs, and claim check must all originate in
    // this one call. A fallback summary is not eligible for manual review.
    const ledger = requireManualGenerationLedger(generated.meta);
    processingStage = "persisting";
    const date = shanghaiDate();
    await writeManualIntakeArtifact(parsed.commentId, `fact_ledger_${date}.json`, {
      date,
      generated_at: new Date().toISOString(),
      ledgers: [{
        topic_key: topic.topic_key,
        ledger,
        fallback_reason: ""
      }]
    }, dataRoot);

    const article: ProcessedArticle = { raw: root, topic, summary: generated.summary, generationMeta: generated.meta };
    await writeManualIntakeArtifact(parsed.commentId, `articles_${date}.json`, [article], dataRoot);
    const review = createReviewStateFromStoredArticles([article], date);
    await writeReviewState(`${directory}/review.json`, review);
    const reviewBody = buildManualReviewIssue({ commentId: parsed.commentId, intakeUrl: persistedUrl, note: parsed.note, article, ledger });
    const reviewBodyPath = await writeManualIntakeTextArtifact(parsed.commentId, "review-issue.md", reviewBody, dataRoot);
    await updateManualIntakeState(state, { status: "review_ready", error: "" }, dataRoot);
    return { ok: true, idempotent: false, commentId: parsed.commentId, directory, reviewBodyPath, reviewIssueNumber: 0 };
  } catch (error) {
    if (error instanceof ClaimCheckDiscardError) {
      // Keep a small, non-sensitive diagnostic. Model responses and the
      // rejected sentences must not be persisted in manual intake data.
      await writeManualIntakeArtifact(parsed.commentId, "claim-check.json", {
        status: "discarded",
        violations: error.violations.map(({ section, rule, severity }) => ({ section, rule, severity }))
      }, dataRoot);
    }
    if (error instanceof ArticleDepthGateError) {
      await writeManualIntakeArtifact(parsed.commentId, "article-depth.json", {
        status: "discarded",
        ...error.assessment
      }, dataRoot);
    }
    if (error instanceof LedgerAdequacyGateError) {
      await writeManualIntakeArtifact(parsed.commentId, "ledger-adequacy.json", {
        status: "discarded",
        ...error.assessment
      }, dataRoot);
    }
    const safeError = classifyManualIntakeError(error, processingStage);
    await updateManualIntakeState(state, { status: "failed", error: safeError }, dataRoot);
    return { ok: false, commentId: parsed.commentId, error: safeError };
  }
}

/** Never persist or expose provider responses, page text, signed URLs, or raw exceptions. */
/**
 * Produces an operationally useful but non-sensitive failure code. In
 * particular, provider response bodies and fetched page text must never be
 * written to an intake state or emitted by the Actions job.
 */
export function classifyManualIntakeError(error: unknown, stage?: ManualIntakeProcessingStage) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/^fetch:[a-z0-9_]+$/u.test(detail)) return detail;
  if (/^topic:/u.test(detail)) return "topic_generation_failed";
  if (/^generation:ledger_not_used:ledger_extraction_failed:.*fact ledger request timeout/u.test(detail)) return "fact_ledger_timeout";
  const ledgerApiStatus = detail.match(/^generation:ledger_not_used:ledger_extraction_failed:.*fact ledger API error: HTTP (\d{3})\b/u)?.[1];
  if (ledgerApiStatus) return `fact_ledger_api_http_${ledgerApiStatus}`;
  if (/^generation:ledger_not_used:ledger_extraction_failed:.*empty response/u.test(detail)) return "fact_ledger_empty_response";
  if (/^generation:ledger_not_used:ledger_extraction_failed:/u.test(detail)) return "fact_ledger_generation_failed";
  if (/^generation:(?:ledger_not_used|ledger_missing|claim_check_missing|claim_check_gated)/u.test(detail)) return "grounding_check_failed";
  if (/^claim_check_gate:/u.test(detail)) return "claim_check_failed";
  if (/^article_depth_gate:/u.test(detail)) return "article_too_thin";
  if (/^evidence_adequacy_gate:/u.test(detail)) return "evidence_too_sparse";
  if (/^ledger_adequacy_gate:/u.test(detail)) return "ledger_too_thin";
  const writingGate = detail.match(/^manual_writing_gate:([a-z_]+)(?::([a-z_]+):([a-z0-9_.]+))?/u);
  if (writingGate) return `grounding_${writingGate.slice(1).filter(Boolean).join("_")}`;
  if (/^AI JSON parse error:/u.test(detail)) return "summary_json_invalid";
  if (/^Gemini network error:/u.test(detail)) return "summary_provider_network_error";
  if (/^Gemini API error: empty response/u.test(detail)) return "summary_provider_empty_response";
  const summaryApiStatus = detail.match(/^Gemini API error: HTTP (\d{3})\b/u)?.[1];
  if (summaryApiStatus) return `summary_provider_http_${summaryApiStatus}`;
  if (stage === "generating") return "summary_generation_failed";
  if (stage === "persisting") return "intake_persistence_failed";
  return "manual_intake_processing_failed";
}

export function requireManualGenerationLedger(meta: TopicGenerationMeta): FactLedger {
  if (!meta.ledger_used) throw new Error(`generation:ledger_not_used:${meta.ledger_fallback_reason || "unknown"}`);
  if (!meta.ledger) throw new Error("generation:ledger_missing");
  if (!meta.claim_check) throw new Error("generation:claim_check_missing");
  if (meta.claim_check.gated_violation_count > 0) throw new Error("generation:claim_check_gated");
  return meta.ledger;
}

function createInitialState(commentId: string, sourceUrl: string, note: string): ManualIntakeState {
  const now = new Date().toISOString();
  return { version: 1, comment_id: commentId, source_url: sourceUrl, note, status: "received", created_at: now, updated_at: now };
}

type ManualExpansion = SourceExpansionResult | { error: string; graceful_fallback: true };

async function expandManualTopic(topic: TopicCandidate): Promise<{ topic: TopicCandidate; expansion: ManualExpansion }> {
  try {
    // Expansion has a daily freshness guard because it normally works on a
    // scheduled queue. Manual intake is an explicit user request, so it gets
    // one bounded research allocation without entering daily selection.
    const temporaryResearchTopic = { ...topic, freshness_label: "today" as const };
    const result = await expandTopicSources([temporaryResearchTopic], {
      maxTopics: 1,
      forceSerper: true,
      relatedAngleQueriesPerTopic: 4
    });
    return { topic: result.topicCandidates[0] ?? topic, expansion: result.expansion };
  } catch {
    return { topic, expansion: { error: "source_expansion_failed", graceful_fallback: true } };
  }
}

export type ManualEvidenceAdequacy = {
  passed: boolean;
  root_document_quality: "usable" | "limited" | "unusable";
  verified_root_expansion_count: number;
  reasons: string[];
};

export function assessManualEvidenceAdequacy(document: IntakeDocument, expansion: ManualExpansion): ManualEvidenceAdequacy {
  const rootQuality = document.extraction_quality?.status ?? assessExtractionQuality(document.text).status;
  const verifiedRootExpansionCount = "evidence" in expansion
    ? expansion.evidence.filter((item) => item.evidence_role !== "related_angle" && item.validation_status === "verified" && item.claim_coverage?.matched !== false).length
    : 0;
  const reasons: string[] = [];
  if (rootQuality !== "usable" && verifiedRootExpansionCount < 1) reasons.push("limited_root_without_verified_expansion");
  return {
    passed: reasons.length === 0,
    root_document_quality: rootQuality,
    verified_root_expansion_count: verifiedRootExpansionCount,
    reasons
  };
}

function verifiedCorroborationEvidence(expansion: ManualExpansion) {
  return "evidence" in expansion
    ? expansion.evidence.filter((item) => item.evidence_role !== "related_angle" && item.validation_status === "verified" && item.claim_coverage?.matched !== false)
    : [];
}

function mergeCachedExpansion(current: ManualExpansion, reused: SourceExpansionResult["evidence"], commentId: string): SourceExpansionResult {
  const base: SourceExpansionResult = "evidence" in current ? current : {
    shortlisted_topic_keys: [], attempted_topic_count: 0, attempted_route_count: 0, success_route_count: 0,
    evidence_count: 0, corroboration_evidence_count: 0, related_angle_evidence_count: 0, attempts: [], evidence: [], observations: []
  };
  const evidence = [...base.evidence, ...reused];
  return {
    ...base,
    evidence,
    evidence_count: evidence.length,
    corroboration_evidence_count: evidence.filter((item) => item.evidence_role !== "related_angle").length,
    related_angle_evidence_count: evidence.filter((item) => item.evidence_role === "related_angle").length,
    reused_from_comment_id: commentId
  };
}

export function preserveManualIntakeRootEvidence(initial: TopicCandidate, researched: TopicCandidate) {
  return {
    ...researched,
    freshness_label: initial.freshness_label,
    published_date_range: initial.published_date_range,
    // Related angles have already passed entity+angle matching and full-page
    // validation. They remain a separate evidence scope and never count as
    // corroboration of the supplied root article.
    related_evidence_articles: researched.related_evidence_articles ?? []
  };
}

export async function findRecentIntakeDocument(
  requestedUrl: string,
  excludeCommentId: string,
  dataRoot = "data",
  now = Date.now()
): Promise<{ commentId: string; document: IntakeDocument } | undefined> {
  const root = path.resolve(dataRoot, "manual-intake");
  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name) && entry.name !== excludeCommentId)
      .map((entry) => entry.name)
      .sort((left, right) => Number(right) - Number(left));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const commentId of entries) {
    try {
      const document = JSON.parse(await fs.readFile(path.join(root, commentId, "document.json"), "utf8")) as IntakeDocument;
      const ageMs = now - Date.parse(document.fetched_at);
      if (redactIntakeUrl(document.requested_url) !== requestedUrl || ageMs < 0 || ageMs > 7 * 86_400_000) continue;
      const quality = document.extraction_quality ?? assessExtractionQuality(document.text);
      if (!document.text || quality.status === "unusable" || !/^https?:\/\//u.test(document.final_url)) continue;
      return { commentId, document };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
}

export async function findRecentVerifiedExpansion(
  requestedUrl: string,
  excludeCommentId: string,
  dataRoot = "data",
  now = Date.now()
): Promise<{ commentId: string; expansion: SourceExpansionResult } | undefined> {
  const root = path.resolve(dataRoot, "manual-intake");
  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name) && entry.name !== excludeCommentId)
      .map((entry) => entry.name)
      .sort((left, right) => Number(right) - Number(left));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const commentId of entries) {
    try {
      const directory = path.join(root, commentId);
      const document = JSON.parse(await fs.readFile(path.join(directory, "document.json"), "utf8")) as IntakeDocument;
      const ageMs = now - Date.parse(document.fetched_at);
      if (redactIntakeUrl(document.requested_url) !== requestedUrl || ageMs < 0 || ageMs > 7 * 86_400_000) continue;
      const expansion = JSON.parse(await fs.readFile(path.join(directory, "expansion.json"), "utf8")) as SourceExpansionResult;
      const evidence = verifiedCorroborationEvidence(expansion);
      if (!evidence.length) continue;
      return { commentId, expansion: { ...expansion, evidence } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
}

export function buildManualResearchTopic(topic: TopicCandidate, root: RawArticle): TopicCandidate {
  const person = topic.main_entities.people[0]?.trim() ?? "";
  const body = `${root.title}\n${root.rawContent || root.excerpt || ""}`;
  const attributedHeadline = body.match(/人民日报(?:刊发|发布|报道|专访|采访)[^《]{0,20}《([^》]{4,60})》/u)?.[1]?.trim() ?? "";
  const queries = [
    buildAggregateFactQuery(root),
    person && attributedHeadline ? `${person} 人民日报 ${attributedHeadline}` : "",
    ...topic.search_queries
  ].filter(Boolean);
  return { ...topic, search_queries: [...new Set(queries)] };
}

function buildAggregateFactQuery(root: RawArticle) {
  const body = `${root.title}\n${root.rawContent || root.excerpt || ""}`;
  if (!/票房/u.test(body)) return "";
  const amount = body.match(/\d+(?:\.\d+)?(?:亿元|万元|亿|万|元)/u)?.[0] ?? "";
  const event = body.match(/(20\d{2})年?\s*(暑期档|春节档|国庆档)/u);
  if (!amount || !event) return "";
  return `${event[1]}${event[2]} 电影票房 ${amount}`;
}

function collectEvidence(root: RawArticle, topic: TopicCandidate): RawArticle[] {
  const rootEvidence = topic.evidence_articles.map((item) => {
    if (item.url === root.url) return { ...root, evidenceRole: "root_corroboration" as const };
    return evidenceArticleToRaw(item, topic.topic_key, "root_corroboration");
  });
  const related = (topic.related_evidence_articles ?? []).map((item) => ({
    ...evidenceArticleToRaw(item, topic.topic_key, "related_angle"),
    angleKind: item.angle_kind
  }));
  return [...rootEvidence, ...related];
}

function evidenceArticleToRaw(
  item: TopicCandidate["evidence_articles"][number] | NonNullable<TopicCandidate["related_evidence_articles"]>[number],
  topicKey: string,
  evidenceRole: "root_corroboration" | "related_angle"
): RawArticle {
  const text = item.key_points.join("\n");
  return {
    title: item.title,
    url: item.url,
    sourceName: item.source_name,
    sourceUrl: item.url,
    category: "持ち込みニュース",
    reliability: item.reliability,
    sourceType: item.source_type,
    publishedDate: item.published_date,
    freshnessLabel: item.freshness_label,
    articleType: item.article_type,
    excerpt: text,
    rawContent: text,
    rawContentLength: text.length,
    topicKey,
    evidenceRole
  };
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type ManualIntakeCliEnv = Record<string, string | undefined>;

type ManualIntakeCliDependencies = {
  processIntake?: typeof processManualIntake;
  appendOutput?: (filePath: string, content: string) => Promise<void>;
};

/** CLI adapter used by GitHub Actions. The comment body and source URL are never logged. */
export async function runManualIntakeCli(
  env: ManualIntakeCliEnv = process.env,
  dependencies: ManualIntakeCliDependencies = {}
): Promise<ManualIntakeProcessResult> {
  const commentId = (env.MANUAL_COMMENT_ID || "").trim();
  const outputPath = env.GITHUB_OUTPUT;
  let result: ManualIntakeProcessResult;
  if (!/^\d+$/u.test(commentId)) {
    result = { ok: false, commentId, error: "MANUAL_COMMENT_ID must be numeric" };
  } else {
    try {
      result = await (dependencies.processIntake ?? processManualIntake)({
        comment: {
          id: commentId,
          body: env.MANUAL_COMMENT_BODY || "",
          authorLogin: env.MANUAL_COMMENT_AUTHOR || "",
          authorAssociation: env.MANUAL_COMMENT_ASSOCIATION || ""
        },
        dataRoot: env.SITE_DATA_DIR || "data",
        provider: normalizeCliProvider(env.AI_PROVIDER)
      });
    } catch (error) {
      result = { ok: false, commentId, error: classifyManualIntakeError(error) };
    }
  }

  if (outputPath) {
    const fields = {
      comment_id: result.commentId,
      directory: result.ok ? result.directory : "",
      review_body_path: result.ok ? result.reviewBodyPath : "",
      review_issue_number: result.ok ? String(result.reviewIssueNumber) : "0",
      result: result.ok ? "review_ready" : "failed",
      error: result.ok ? "" : result.error
    };
    const content = Object.entries(fields).map(([key, value]) => `${key}=${sanitizeGithubOutputValue(value)}`).join("\n") + "\n";
    await (dependencies.appendOutput ?? appendGithubOutput)(outputPath, content);
  }
  return result;
}

function normalizeCliProvider(value: string | undefined): AiProvider | undefined {
  return value === "gemini" || value === "deepseek" ? value : undefined;
}

function sanitizeGithubOutputValue(value: string) {
  return value.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

async function appendGithubOutput(filePath: string, content: string) {
  await fs.appendFile(filePath, content, "utf8");
}

/**
 * Executes the CLI adapter and reports only the safe, short status used by
 * GitHub Actions. Exported so Actions can call it from an explicit entrypoint
 * instead of relying on a TypeScript module's direct-execution detection.
 */
export async function runManualIntakeMain() {
  const result = await runManualIntakeCli();
  console.log(`manual intake: comment ${result.commentId || "unknown"} / ${result.ok ? "review_ready" : "failed"}`);
  if (!result.ok) {
    console.warn(`manual intake error: ${sanitizeGithubOutputValue(result.error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runManualIntakeMain().catch((error) => {
    console.warn(`manual intake fatal: ${classifyManualIntakeError(error)}`);
    process.exitCode = 1;
  });
}
