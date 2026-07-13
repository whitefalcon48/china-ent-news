import "dotenv/config";
import { classifyArticle, getArticleDateInfo, isPublishableType, loadFilterConfig } from "./classifyArticle.js";
import { dedupeArticles } from "./dedupe.js";
import { enrichArticleContent, enrichArticleMetadata, fetchAllSources, loadSources } from "./fetchSources.js";
import { fetchHotSearchArticles } from "./fetchHotSearch.js";
import { expandTopicSources } from "./expandSources.js";
import { ClaimCheckDiscardError } from "./claimCheck.js";
import { writeFactLedgerFile } from "./factLedger.js";
import { createLlmCallBudget, hasLlmBudgetRemaining, LlmCallBudgetExceededError } from "./llmCallBudget.js";
import { renderMarkdownFile } from "./renderMarkdown.js";
import { buildSelectionTrace, candidateKey, writeSelectionTraceFile, type SourceSelectionDiagnostic } from "./selectionTrace.js";
import { OUTPUT_COUNT_INSTRUCTION, describeError, getAiProvider, getProviderEnvStatus, summarizeArticle, summarizeTopic } from "./summarizeWithGemini.js";
import { buildTopicCandidates, writeTopicCandidatesFile } from "./topicCandidates.js";
import { extractTopicSeeds } from "./topicSeeds.js";
import type { ArticleType, FeedCategory, ProcessedArticle, RawArticle, SourceDiagnostic, SourceTypeLabel, SummarizedArticle, TopicCandidate, TopicGenerationMeta } from "./types.js";

const MAX_ARTICLES_PER_SOURCE = 3;
const MAX_TOPICS_PER_PRIMARY_SOURCE = 2;
const MAX_SNS_ONLY_TOPICS = 2;
const MAX_LOW_PRIORITY_ARTICLES = 3;
const CATEGORY_LIMITS: Partial<Record<FeedCategory, number>> = {
  "映画": 2,
  "ドラマ・配信": 2,
  "芸能・俳優": 2,
  "業界動向": 2,
  "公式発表": 2
};
const ROTATION_CATEGORIES: FeedCategory[] = ["映画", "ドラマ・配信", "芸能・俳優", "業界動向", "公式発表"];
const MIN_RAW_CONTENT_LENGTH = 180;
const MIN_OFFICIAL_RAW_CONTENT_LENGTH = 80;

async function main() {
  const llmCallBudget = createLlmCallBudget();
  const maxArticles = Number(process.env.MAX_DEEPSEEK_INPUT_CANDIDATES || process.env.MAX_AI_INPUT_CANDIDATES || process.env.MAX_ARTICLES || 10);
  const sources = await loadSources();
  const filterConfig = await loadFilterConfig();
  const provider = getAiProvider();
  const topicFirstEnabled = process.env.TOPIC_FIRST !== "false";
  const aiEnv = getProviderEnvStatus(provider);

  console.log(`収集元: ${sources.length}件`);
  console.log(`AI_PROVIDER: ${provider}`);
  console.log(`TOPIC_FIRST: ${topicFirstEnabled}`);
  console.log(`${provider === "gemini" ? "GEMINI_API_KEY" : "DEEPSEEK_API_KEY"}: ${aiEnv.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`AI_MODEL: ${aiEnv.model}`);

  const { articles: sourceArticles, errors, diagnostics } = await fetchAllSources(sources);
  const hotSearch = await fetchHotSearchArticles();
  const articles = [...sourceArticles, ...hotSearch.articles];
  const metadataEnrichedArticles = await enrichMissingDateMetadata(articles);
  const dedupedArticles = dedupeArticles(metadataEnrichedArticles);
  const classifiedArticles = attachRelatedSources(dedupedArticles.map((article) => classifyArticle(article, filterConfig)));
  const topicMergeResult = mergeTopicDuplicates(classifiedArticles);
  const generationCandidatePool = topicMergeResult.articles.map(prepareGenerationCandidate);
  const topicCandidateArticlePool = classifiedArticles.map(prepareGenerationCandidate);
  const topicSeedExtraction = await extractTopicSeeds(topicCandidateArticlePool, provider, llmCallBudget);
  const baseTopicCandidates = buildTopicCandidates(topicCandidateArticlePool, topicSeedExtraction.seeds);
  const topicExpansion = await expandTopicSources(baseTopicCandidates);
  const topicCandidates = topicExpansion.topicCandidates;
  const topicCandidatesPath = await writeTopicCandidatesFile(topicCandidates, undefined, {
    topic_seed_extraction: topicSeedExtraction,
    source_expansion: topicExpansion.expansion
  });
  const droppedReasons = new Map<string, string>();
  const selectionReasons = new Map<string, string>();
  markNonPublishableTraceDrops(generationCandidatePool, droppedReasons);
  const preAiExclusions = classifiedArticles
    .filter((article) => article.skipReason || !isGenerationEligibleBeforeFreshness(article))
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: article.skipReason || article.articleType || "not_generation_eligible"
    }));
  const eligibleArticles = generationCandidatePool.filter(isGenerationEligibleBeforeFreshness);
  const freshnessExclusions = eligibleArticles
    .filter((article) => !isFreshEnoughForNormalFeed(article))
    .map((article) => ({
      title: article.title,
      type: article.articleType ?? "unknown",
      reason: `freshness_${article.freshnessLabel ?? "unknown"}${article.publishedDate ? `(${article.publishedDate})` : ""}`
    }));
  markFreshnessTraceDrops(eligibleArticles, droppedReasons);
  const freshEligibleArticles = eligibleArticles.filter(isFreshEnoughForNormalFeed);
  const legacySelectedCandidates = expandSelectionForAi(
    selectArticlesForAi(freshEligibleArticles, maxArticles, MAX_ARTICLES_PER_SOURCE),
    freshEligibleArticles,
    maxArticles,
    MAX_ARTICLES_PER_SOURCE
  );
  markSelectionLimitTraceDrops(freshEligibleArticles, legacySelectedCandidates, droppedReasons, maxArticles, MAX_ARTICLES_PER_SOURCE);
  const topicSelection = topicFirstEnabled
    ? selectTopicsForAi(topicCandidates, topicCandidateArticlePool, maxArticles)
    : { selected: [], dropped: [], backfillCandidates: [] };
  const topicEvidenceBundles = topicFirstEnabled
    ? await buildTopicEvidenceBundles(topicSelection.selected, topicCandidateArticlePool)
    : [];
  const thinTopicKeys = new Set(
    topicEvidenceBundles.filter((bundle) => isTooThinForPublishing(bundle.evidence[0])).map((bundle) => bundle.topic.topic_key)
  );
  for (const topicKey of thinTopicKeys) {
    const selected = topicSelection.selected.find((item) => item.topic.topic_key === topicKey);
    if (selected) topicSelection.dropped.push({ topic: selected.topic, reason: "topic_raw_content_too_short" });
  }
  topicSelection.selected = topicSelection.selected.filter((item) => !thinTopicKeys.has(item.topic.topic_key));
  const usableTopicBundles = topicEvidenceBundles.filter((bundle) => !thinTopicKeys.has(bundle.topic.topic_key));
  const enrichedSelectedCandidates = topicFirstEnabled
    ? usableTopicBundles.map((bundle) => bundle.evidence[0])
    : await Promise.all(legacySelectedCandidates.map((article) => enrichArticleContent(article)));
  const thinArticles = topicFirstEnabled ? [] : enrichedSelectedCandidates.filter(isTooThinForPublishing);
  markRawContentTraceDrops(thinArticles, droppedReasons);
  const rawContentExclusions = thinArticles.map((article) => ({
    title: article.title,
    type: article.articleType ?? "unknown",
    reason: `raw_content_too_short(${article.rawContentLength ?? 0})`
  }));
  const selectedArticles = enrichedSelectedCandidates.filter((article) => !isTooThinForPublishing(article));
  markSelectedTraceReasons(selectedArticles, selectionReasons);
  const enrichedDiagnostics = enrichDiagnostics(diagnostics, dedupedArticles, selectedArticles);
  const processed: ProcessedArticle[] = [];
  const aiErrors: string[] = [];
  const postAiExclusions: Array<{ title: string; type: ArticleType; reason: string }> = [];
  const topicFailures: Array<{ topic_key: string; stage: "ai_error" | "post_ai_exclude" | "claim_check_gate"; reason: string }> = [];
  const backfilledTopicKeys: string[] = [];
  const deepseekInputArticles = [...selectedArticles];

  logSourceDiagnostics(enrichedDiagnostics);
  logArticleTypeCounts(classifiedArticles);
  logMetadataCounts(classifiedArticles);
  logExclusions("除外記事", preAiExclusions);
  logExclusions("本文量不足の除外記事", rawContentExclusions);
  console.log(`topic_key生成件数: ${new Set(classifiedArticles.map((article) => article.topicKey).filter(Boolean)).size}`);
  console.log(`topic統合件数: ${topicMergeResult.mergedTopicCount}`);
  console.log(
    `topic_seed抽出: ${topicSeedExtraction.succeeded ? "LLM成功" : topicSeedExtraction.attempted ? "LLM失敗・regex fallback" : "未実行・regex fallback"}`
  );
  if (topicSeedExtraction.error) {
    console.log(`topic_seed抽出エラー: ${topicSeedExtraction.error}`);
  }
  console.log(`topic_candidates出力先: ${topicCandidatesPath}`);
  console.log(`topic_candidates件数: ${topicCandidates.length}`);
  logSourceExpansion(topicExpansion.expansion);
  logDuplicateCandidates(topicMergeResult.duplicateCandidates);
  console.log(`HOT SEARCH取得: ${hotSearch.articles.length}件`);
  hotSearch.statusLines.forEach((line) => console.log(`- ${line}`));
  logFinalSourceDistribution(selectedArticles);
  logFinalCategoryDistribution(selectedArticles, "最終AI処理対象のカテゴリ配分");

  if (topicFirstEnabled) {
    const snsOnlyCount = topicSelection.selected.filter((item) => isSnsOnlySingleEvidence(item.topic)).length;
    const multiSourceCount = topicSelection.selected.filter((item) => item.topic.signals.has_multiple_sources).length;
    console.log(`topic選定: ${topicSelection.selected.length}件（SNS単独${snsOnlyCount}件・複数ソース${multiSourceCount}件）`);
  }

  const generationItems: Array<{ article: RawArticle; topic?: TopicCandidate; evidence: RawArticle[]; selectedTopic?: SelectedTopic }> = topicFirstEnabled
    ? usableTopicBundles.map((bundle) => ({ article: bundle.evidence[0], topic: bundle.topic, evidence: bundle.evidence, selectedTopic: bundle.selectedTopic }))
    : selectedArticles.map((article) => ({ article, topic: undefined, evidence: [article] }));
  const attemptedTopicKeys = new Set(generationItems.map((item) => item.topic?.topic_key).filter((key): key is string => Boolean(key)));
  let backfillCount = 0;
  let backfillLowPriorityCount = topicSelection.selected.filter((item) => item.representative.isLowPriority).length;

  for (let generationIndex = 0; generationIndex < generationItems.length && processed.length < maxArticles; generationIndex++) {
    const item = generationItems[generationIndex];
    const { article, topic, evidence } = item;
    try {
      console.log(`AI処理中: ${topic ? `[topic] ${topic.topic_key} (evidence ${evidence.length}件)` : article.title}`);
      console.log(`source: ${article.sourceName}`);
      console.log(`rawContentLength: ${article.rawContentLength ?? 0}`);
      console.log(`articleType: ${article.articleType ?? "unknown"}`);
      console.log(`category: ${article.feedCategory ?? article.category}`);
      console.log(`badge: ${article.badge ?? "NEWS"}`);
      console.log(`sourceType: ${article.sourceType ?? "media_report"}`);
      console.log(`freshnessLabel: ${article.freshnessLabel ?? "unknown"}`);
      console.log(`newsworthinessScore: ${article.newsworthinessScore ?? 0}`);
      let summary: SummarizedArticle;
      let generationMeta: TopicGenerationMeta | undefined;
      if (topic) {
        const result = await summarizeTopic(topic, evidence, provider, llmCallBudget);
        summary = result.summary;
        generationMeta = result.meta;
      } else {
        summary = await summarizeArticle(article, provider, llmCallBudget);
      }
      if (topic && summary.article_type === "unknown" && !summary.skip_reason) {
        summary = { ...summary, article_type: getRescuedTopicArticleType(topic, article) };
      }
      if (!isPublishableType(summary.article_type)) {
        const reason = summary.skip_reason || (summary.article_type === "unknown" ? "article_type_unknown_llm" : summary.article_type);
        postAiExclusions.push({
          title: article.title,
          type: summary.article_type,
          reason
        });
        if (topic) {
          topicFailures.push({ topic_key: topic.topic_key, stage: "post_ai_exclude", reason });
          await enqueueTopicBackfill(item.selectedTopic, "post_ai_exclude");
        }
        continue;
      }
      processed.push({ raw: article, summary, topic, generationMeta });
    } catch (error) {
      const message = describeError(error);
      aiErrors.push(`${article.title}: ${message}`);
      console.error(`AI処理エラー: ${article.title}: ${message}`);
      if (topic) {
        if (error instanceof ClaimCheckDiscardError) {
          const reason = error.violations.map((violation) => `${violation.rule}:${violation.detail}`).join(" | ");
          topicFailures.push({ topic_key: topic.topic_key, stage: "claim_check_gate", reason });
          await enqueueTopicBackfill(item.selectedTopic, "claim_check_gate");
        } else {
          const reason = error instanceof LlmCallBudgetExceededError ? "llm_call_budget_exceeded" : message;
          topicFailures.push({ topic_key: topic.topic_key, stage: "ai_error", reason });
          await enqueueTopicBackfill(item.selectedTopic, "ai_error");
        }
      }
    }
  }

  function getRescuedTopicArticleType(topic: TopicCandidate, representative: RawArticle): ArticleType {
    const representativeType = representative.articleType ?? "unknown";
    if (isPublishableType(representativeType)) return representativeType;
    if (topic.topic_type === "gossip_rumor") return "gossip_rumor";
    if (topic.topic_type === "box_office") return "data_report";
    if (topic.topic_type === "policy") return "official_announcement";
    return "news_event";
  }

  async function enqueueTopicBackfill(
    failedItem: SelectedTopic | undefined,
    stage: "ai_error" | "post_ai_exclude" | "claim_check_gate"
  ) {
    if (!hasLlmBudgetRemaining(llmCallBudget)) return;
    if (!topicFirstEnabled || !failedItem || backfillCount >= maxArticles) return;
    while (backfillCount < maxArticles) {
      const sameCategoryCandidates = topicSelection.backfillCandidates.filter(
        (candidate) => candidate.category === failedItem.category && !attemptedTopicKeys.has(candidate.topic.topic_key)
      );
      const replacement = sameCategoryCandidates.find((candidate) => !candidate.representative.isLowPriority) ??
        (backfillLowPriorityCount < MAX_LOW_PRIORITY_ARTICLES
          ? sameCategoryCandidates.find((candidate) => candidate.representative.isLowPriority)
          : undefined);
      if (!replacement) return;
      attemptedTopicKeys.add(replacement.topic.topic_key);
      backfillCount++;
      const bundle = await buildTopicEvidenceBundle(replacement, topicCandidateArticlePool);
      if (isTooThinForPublishing(bundle.evidence[0])) {
        topicSelection.dropped.push({ topic: replacement.topic, reason: "topic_raw_content_too_short" });
        topicFailures.push({ topic_key: replacement.topic.topic_key, stage: "post_ai_exclude", reason: "topic_raw_content_too_short" });
        continue;
      }
      replacement.selectionReason = `backfill_after_${stage}`;
      if (replacement.representative.isLowPriority) backfillLowPriorityCount++;
      topicSelection.dropped = topicSelection.dropped.filter((item) => item.topic.topic_key !== replacement.topic.topic_key);
      topicSelection.selected.push(replacement);
      generationItems.push({
        article: bundle.evidence[0],
        topic: bundle.topic,
        evidence: bundle.evidence,
        selectedTopic: replacement
      });
      deepseekInputArticles.push(bundle.evidence[0]);
      backfilledTopicKeys.push(replacement.topic.topic_key);
      return;
    }
  }

  const factLedgerPath = await writeFactLedgerFile(
    processed
      .filter((article) => article.topic && article.generationMeta)
      .map((article) => ({
        topic_key: article.topic?.topic_key ?? article.generationMeta?.topic_key ?? "",
        ledger: article.generationMeta?.ledger ?? null,
        fallback_reason: article.generationMeta?.ledger_fallback_reason ?? ""
      }))
  );
  const outputPath = await renderMarkdownFile(processed, provider);
  const nonOfficialSourceDiagnostics = buildNonOfficialSourceDiagnostics(
    sources,
    diagnostics,
    classifiedArticles,
    generationCandidatePool,
    selectedArticles,
    droppedReasons
  );
  const selectionTrace = buildSelectionTrace({
    provider,
    candidatePool: generationCandidatePool,
    deepseekInput: deepseekInputArticles,
    processed,
    droppedReasons,
    selectionReasons,
    outputCountInstruction: OUTPUT_COUNT_INSTRUCTION,
    nonOfficialSourceDiagnostics,
    topicCandidates,
    topicSelection: {
      enabled: topicFirstEnabled,
      selected: topicSelection.selected.map((item) => ({
        topic_key: item.topic.topic_key,
        category: item.category,
        primary_source: item.representative.sourceName,
        score: item.score,
        evidence_urls: item.topic.evidence_articles.map((evidence) => evidence.url),
        selection_reason: item.selectionReason
      })),
      dropped: topicSelection.dropped.map((item) => ({ topic_key: item.topic.topic_key, reason: item.reason })),
      failed: topicFailures,
      backfilled: backfilledTopicKeys
    },
    droppedTopics: topicSelection.dropped.map((item) => ({ ...item.topic, reason: item.reason })),
    topicLayerNote: topicFirstEnabled
      ? "Topic-first generation enabled. DeepSeek input contains one representative article per selected topic."
      : "Topic-first generation disabled. Legacy article-level selection and generation enabled.",
    sourceExpansion: topicExpansion.expansion,
    llmCallBudget
  });
  const tracePath = await writeSelectionTraceFile(selectionTrace);
  logExclusions("AI処理後の除外記事", postAiExclusions);
  logFinalSourceDistribution(
    processed.map((article) => article.raw),
    "最終出力のsource配分"
  );
  logFinalCategoryDistribution(
    processed.map((article) => article.raw),
    "最終出力のカテゴリ配分"
  );

  console.log("");
  console.log("実行結果");
  console.log(`- 取得した記事数: ${articles.length}`);
  console.log(`- 日付補完後の記事数: ${metadataEnrichedArticles.length}`);
  console.log(`- 重複除去後の記事数: ${dedupedArticles.length}`);
  console.log(`- 除外件数: ${preAiExclusions.length + rawContentExclusions.length + postAiExclusions.length}`);
  console.log(`- AI処理対象の記事数: ${selectedArticles.length}`);
  console.log(`- AI処理した記事数: ${processed.filter((article) => article.summary).length}`);
  console.log(`- 最終出力件数: ${processed.filter((article) => article.summary).length}`);
  console.log(`- Markdown出力先: ${outputPath}`);
  console.log(`- Topic candidates: ${topicCandidatesPath}`);
  console.log(`- Fact ledger: ${factLedgerPath}`);
  console.log(`- Selection trace: ${tracePath}`);
  console.log(`candidates: ${selectionTrace.candidate_pool.length} -> deepseek_input: ${selectionTrace.deepseek_input.count} -> output: ${selectionTrace.final_output.length}`);

  if (errors.length) {
    console.log("- エラーがあった収集元:");
    errors.forEach((error) => console.log(`  - ${error}`));
  } else {
    console.log("- エラーがあった収集元: なし");
  }

  if (aiErrors.length) {
    console.log("- AI処理エラー:");
    aiErrors.forEach((error) => console.log(`  - ${error}`));
  }
}

async function enrichMissingDateMetadata(articles: RawArticle[]) {
  const results: RawArticle[] = [];
  const queue = [...articles];
  const workerCount = Math.min(5, queue.length || 1);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const article = queue.shift();
        if (!article) {
          continue;
        }
        const dateInfo = getArticleDateInfo(article);
        if (dateInfo.dateSource !== "unknown") {
          results.push(article);
          continue;
        }
        results.push(await enrichArticleMetadata(article));
      }
    })
  );

  return results;
}

function buildNonOfficialSourceDiagnostics(
  sources: Awaited<ReturnType<typeof loadSources>>,
  diagnostics: SourceDiagnostic[],
  classifiedArticles: RawArticle[],
  candidatePool: RawArticle[],
  selectedArticles: RawArticle[],
  droppedReasons: Map<string, string>
): SourceSelectionDiagnostic[] {
  const diagnosticsBySource = new Map(diagnostics.map((diagnostic) => [diagnostic.sourceName, diagnostic]));
  const selectedCounts = countBySource(selectedArticles);

  return sources
    .filter((source) => source.reliability !== "A")
    .map((source) => {
      const diagnostic = diagnosticsBySource.get(source.name);
      const sourceArticles = classifiedArticles.filter((article) => article.sourceName === source.name);
      const sourceCandidates = candidatePool.filter((article) => article.sourceName === source.name);
      const freshArticles = sourceArticles.filter(isFreshEnoughForNormalFeed);
      const aiCandidateCount = sourceCandidates.filter((article) => isGenerationEligibleBeforeFreshness(article) && isFreshEnoughForNormalFeed(article)).length;
      const validDateCount = sourceArticles.filter((article) => Boolean(article.publishedDate)).length;
      const freshCount = freshArticles.length;

      return {
        source: source.name,
        raw_count: diagnostic?.rawCount ?? diagnostic?.fetchedCount ?? 0,
        after_url_exclude_count: diagnostic?.afterUrlExcludeCount ?? diagnostic?.fetchedCount ?? 0,
        after_dedupe_count: sourceArticles.length,
        valid_date_count: validDateCount,
        fresh_count: freshCount,
        ai_candidate_count: aiCandidateCount,
        selected_for_deepseek_count: selectedCounts.get(source.name) ?? 0,
        main_drop_reason: getSourceMainDropReason(source.name, diagnostic, sourceArticles, sourceCandidates, selectedArticles, droppedReasons, aiCandidateCount),
        date_pipeline_note: getDatePipelineNote(sourceArticles)
      };
    });
}

function getDatePipelineNote(sourceArticles: RawArticle[]) {
  if (!sourceArticles.length) {
    return "";
  }
  const unknownCount = sourceArticles.filter((article) => !article.publishedDate || article.freshnessLabel === "unknown").length;
  if (!unknownCount) {
    return "";
  }
  return "audit:sources enriches missing dates from article HTML; generation selection uses metadata available before content enrichment, so unknown-date counts can differ";
}

function getSourceMainDropReason(
  sourceName: string,
  diagnostic: SourceDiagnostic | undefined,
  sourceArticles: RawArticle[],
  sourceCandidates: RawArticle[],
  selectedArticles: RawArticle[],
  droppedReasons: Map<string, string>,
  aiCandidateCount: number
) {
  const rawCount = diagnostic?.rawCount ?? diagnostic?.fetchedCount ?? 0;
  const afterUrlExcludeCount = diagnostic?.afterUrlExcludeCount ?? diagnostic?.fetchedCount ?? 0;

  if (diagnostic?.error) {
    return "fetch_failed:" + diagnostic.error;
  }
  if (rawCount === 0) {
    return "fetch_empty";
  }
  if (afterUrlExcludeCount === 0) {
    return "url_exclude_all";
  }
  if (!sourceArticles.length) {
    return "dedupe_or_fetch_filter_removed_all";
  }
  if (!sourceArticles.some((article) => article.publishedDate)) {
    return "date_unknown_all";
  }
  if (!sourceArticles.some(isFreshEnoughForNormalFeed)) {
    return getDominantFreshnessReason(sourceArticles);
  }
  if (aiCandidateCount === 0) {
    return getDominantArticleDropReason(sourceArticles);
  }
  if (!selectedArticles.some((article) => article.sourceName === sourceName)) {
    return getDominantSelectionDropReason(sourceCandidates, droppedReasons) || "not_selected_for_deepseek";
  }
  return "selected_for_deepseek";
}

function getDominantFreshnessReason(articles: RawArticle[]) {
  const counts = countStrings(articles.map((article) => article.freshnessLabel ?? "unknown"));
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  return "no_fresh_articles:" + dominant;
}

function getDominantArticleDropReason(articles: RawArticle[]) {
  const reasons = articles.map((article) => {
    if (article.skipReason) {
      return "skip:" + article.skipReason;
    }
    if (!isGenerationEligibleBeforeFreshness(article)) {
      return "article_type:" + (article.articleType ?? "unknown");
    }
    if (!isFreshEnoughForNormalFeed(article)) {
      return "freshness:" + (article.freshnessLabel ?? "unknown");
    }
    return "unknown";
  });
  return mostCommon(reasons) || "not_ai_candidate";
}

function getDominantSelectionDropReason(articles: RawArticle[], droppedReasons: Map<string, string>) {
  return mostCommon(articles.map((article) => droppedReasons.get(candidateKey(article)) ?? "").filter(Boolean));
}

function countStrings(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function mostCommon(values: string[]) {
  return [...countStrings(values).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function prepareGenerationCandidate(article: RawArticle): RawArticle {
  if (isFreshUnknownGenerationCandidate(article)) {
    return {
      ...article,
      isLowPriority: true
    };
  }

  return article;
}

function isGenerationEligibleBeforeFreshness(article: RawArticle) {
  if (article.skipReason) {
    return false;
  }
  return isPublishableType(article.articleType ?? "unknown") || isFreshUnknownGenerationCandidate(article);
}

function isFreshUnknownGenerationCandidate(article: RawArticle) {
  if ((article.articleType ?? "unknown") !== "unknown") {
    return false;
  }
  if (!isFreshEnoughForNormalFeed(article)) {
    return false;
  }
  if (article.reliability === "A") {
    return false;
  }

  return isEntertainmentCandidate(article);
}

function isEntertainmentCandidate(article: RawArticle) {
  const text = [article.sourceName, article.category, article.feedCategory, article.title, article.excerpt ?? ""].join(" ");
  return /1905|sina|ent|bjnews|jiemian|thepaper|movie|film|drama|series|actor|actress|entertainment|cinema|video|stream|\u7535\u5f71|\u5f71\u89c6|\u5a31\u4e50|\u660e\u661f|\u6f14\u5458|\u5267|\u7f51\u5267|\u77ed\u5267|\u7968\u623f|\u6863\u671f|\u9662\u7ebf|\u4ea7\u4e1a/.test(text);
}

function markNonPublishableTraceDrops(articles: RawArticle[], droppedReasons: Map<string, string>) {
  for (const article of articles) {
    if (article.skipReason) {
      setTraceDropReason(article, droppedReasons, `pre_ai_exclude:${article.skipReason}`);
      continue;
    }

    if (!isGenerationEligibleBeforeFreshness(article)) {
      setTraceDropReason(article, droppedReasons, `article_type_exclude:${article.articleType ?? "unknown"}`);
    }
  }
}

function markFreshnessTraceDrops(articles: RawArticle[], droppedReasons: Map<string, string>) {
  for (const article of articles) {
    if (!isFreshEnoughForNormalFeed(article)) {
      const label = article.freshnessLabel ?? "unknown";
      const publishedDate = article.publishedDate ? `:${article.publishedDate}` : "";
      setTraceDropReason(article, droppedReasons, `freshness_${label}${publishedDate}`);
    }
  }
}

function markSelectionLimitTraceDrops(
  candidateArticles: RawArticle[],
  selectedArticles: RawArticle[],
  droppedReasons: Map<string, string>,
  maxArticles: number,
  maxPerSource: number
) {
  const selectedKeys = new Set(selectedArticles.map(candidateKey));
  const selectedSourceCounts = countBySource(selectedArticles);
  const selectedCategoryCounts = new Map<string, number>();
  let selectedLowPriorityCount = 0;

  for (const article of selectedArticles) {
    const category = article.feedCategory ?? article.category;
    selectedCategoryCounts.set(category, (selectedCategoryCounts.get(category) ?? 0) + 1);
    if (article.isLowPriority) {
      selectedLowPriorityCount += 1;
    }
  }

  for (const article of candidateArticles) {
    if (selectedKeys.has(candidateKey(article))) {
      continue;
    }

    const category = article.feedCategory ?? article.category;
    const categoryLimit = article.feedCategory ? CATEGORY_LIMITS[article.feedCategory] ?? 1 : 1;
    let reason = "selection_rotation_or_limit";

    if (selectedArticles.length >= maxArticles) {
      reason = "count_limit";
    } else if ((selectedSourceCounts.get(article.sourceName) ?? 0) >= maxPerSource) {
      reason = "source_limit";
    } else if ((selectedCategoryCounts.get(category) ?? 0) >= categoryLimit) {
      reason = "category_limit";
    } else if (article.isLowPriority && selectedLowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) {
      reason = "low_priority_limit";
    }

    setTraceDropReason(article, droppedReasons, reason);
  }
}

function markRawContentTraceDrops(articles: RawArticle[], droppedReasons: Map<string, string>) {
  for (const article of articles) {
    setTraceDropReason(article, droppedReasons, `raw_content_too_short:${article.rawContentLength ?? 0}`);
  }
}

function setTraceDropReason(article: RawArticle, droppedReasons: Map<string, string>, reason: string) {
  const key = candidateKey(article);
  if (!droppedReasons.has(key)) {
    droppedReasons.set(key, reason);
  }
}

function isFreshEnoughForNormalFeed(article: RawArticle) {
  if (article.publishedDate && article.publishedDate < "2026-01-01") {
    return false;
  }
  return ["today", "yesterday", "recent"].includes(article.freshnessLabel ?? "unknown");
}

function attachRelatedSources(articles: RawArticle[]) {
  const topicSources = new Map<string, Map<string, string>>();
  for (const article of articles) {
    if (!article.topicKey) {
      continue;
    }
    const sources = topicSources.get(article.topicKey) ?? new Map<string, string>();
    sources.set(article.sourceName, article.url);
    topicSources.set(article.topicKey, sources);
  }

  return articles.map((article) => ({
    ...article,
    relatedSources: article.topicKey
      ? [...(topicSources.get(article.topicKey) ?? new Map([[article.sourceName, article.url]])).entries()].map(([name, url]) => ({ name, url }))
      : [{ name: article.sourceName, url: article.url }]
  }));
}

function mergeTopicDuplicates(articles: RawArticle[]) {
  const groups = new Map<string, RawArticle[]>();
  for (const article of articles) {
    const key = article.topicKey || article.title;
    const group = groups.get(key) ?? [];
    group.push(article);
    groups.set(key, group);
  }

  const mergedArticles: RawArticle[] = [];
  const duplicateCandidates: Array<{ topicKey: string; titles: string[]; sources: string[] }> = [];
  let mergedTopicCount = 0;

  for (const [topicKey, group] of groups.entries()) {
    const relatedSources = dedupeSourceRefs(group.flatMap((article) => article.relatedSources ?? [{ name: article.sourceName, url: article.url }]));
    const representative = [...group].sort(compareArticlesForAiInput)[0];
    mergedArticles.push({
      ...representative,
      relatedSources
    });

    if (group.length > 1) {
      mergedTopicCount += group.length - 1;
      duplicateCandidates.push({
        topicKey,
        titles: group.map((article) => article.title),
        sources: [...new Set(group.map((article) => article.sourceName))]
      });
    }
  }

  return { articles: mergedArticles, duplicateCandidates, mergedTopicCount };
}

function dedupeSourceRefs(sources: NonNullable<RawArticle["relatedSources"]>) {
  const byName = new Map<string, string | undefined>();
  for (const source of sources) {
    if (!byName.has(source.name)) {
      byName.set(source.name, source.url);
    }
  }
  return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

function expandSelectionForAi(selectedArticles: RawArticle[], candidateArticles: RawArticle[], maxArticles: number, maxPerSource: number) {
  if (selectedArticles.length >= maxArticles) {
    return selectedArticles;
  }

  const selectedKeys = new Set(selectedArticles.map(candidateKey));
  const sourceCounts = countBySource(selectedArticles);
  let lowPriorityCount = selectedArticles.filter((article) => article.isLowPriority).length;
  const expanded = [...selectedArticles];
  const remaining = candidateArticles
    .filter((article) => !selectedKeys.has(candidateKey(article)))
    .sort(compareArticlesForAiInput);

  for (const article of remaining) {
    if (expanded.length >= maxArticles) {
      break;
    }
    if ((sourceCounts.get(article.sourceName) ?? 0) >= maxPerSource) {
      continue;
    }
    if (article.isLowPriority && lowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) {
      continue;
    }

    expanded.push(article);
    selectedKeys.add(candidateKey(article));
    sourceCounts.set(article.sourceName, (sourceCounts.get(article.sourceName) ?? 0) + 1);
    if (article.isLowPriority) {
      lowPriorityCount += 1;
    }
  }

  return expanded;
}

function compareArticlesForAiInput(a: RawArticle, b: RawArticle) {
  return getAiInputPriorityScore(b) - getAiInputPriorityScore(a);
}

type SelectedTopic = {
  topic: TopicCandidate;
  representative: RawArticle;
  category: FeedCategory;
  score: number;
  selectionReason: string;
};

function selectTopicsForAi(topicCandidates: TopicCandidate[], articlePool: RawArticle[], maxTopics: number) {
  const articlesByUrl = new Map(articlePool.map((article) => [article.url, article]));
  const dropped: Array<{ topic: TopicCandidate; reason: string }> = [];
  const eligible: SelectedTopic[] = [];

  for (const topic of topicCandidates) {
    if (!["today", "yesterday", "recent"].includes(topic.freshness_label)) {
      dropped.push({ topic, reason: "topic_not_fresh" });
      continue;
    }
    const publishableEvidence = topic.evidence_articles
      .map((evidence) => articlesByUrl.get(evidence.url))
      .filter((article): article is RawArticle => Boolean(article))
      .filter((article) => isGenerationEligibleBeforeFreshness(article) && isFreshEnoughForNormalFeed(article));
    if (!publishableEvidence.length) {
      dropped.push({ topic, reason: "topic_no_publishable_evidence" });
      continue;
    }
    const representative = [...publishableEvidence].sort(compareArticlesForAiInput)[0];
    eligible.push({
      topic,
      representative,
      category: representative.feedCategory ?? "その他",
      score: getTopicSelectionScore(topic, publishableEvidence),
      selectionReason: topic.selection_reason
    });
  }

  const groups = new Map<FeedCategory, SelectedTopic[]>();
  for (const item of eligible) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  for (const group of groups.values()) group.sort((a, b) => b.score - a.score || a.topic.topic_key.localeCompare(b.topic.topic_key, "ja"));

  const selected: SelectedTopic[] = [];
  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<FeedCategory, number>();
  let snsOnlyCount = 0;
  let lowPriorityCount = 0;
  const finalFillCandidates: SelectedTopic[] = [];

  while (selected.length < maxTopics) {
    let added = false;
    for (const category of ROTATION_CATEGORIES) {
      if (selected.length >= maxTopics) break;
      const group = groups.get(category) ?? [];
      while (group.length) {
        const item = group.shift()!;
        const reason = getTopicLimitReason(item, selected.length, maxTopics, sourceCounts, categoryCounts, snsOnlyCount, lowPriorityCount);
        if (reason) {
          if (reason === "topic_category_limit") finalFillCandidates.push(item);
          else dropped.push({ topic: item.topic, reason });
          continue;
        }
        addSelectedTopic(item, selected, sourceCounts, categoryCounts);
        if (isSnsOnlySingleEvidence(item.topic)) snsOnlyCount++;
        if (item.representative.isLowPriority) lowPriorityCount++;
        added = true;
        break;
      }
    }
    if (!added) break;
  }

  for (const group of groups.values()) finalFillCandidates.push(...group);
  const uniqueFinalFill = [...new Map(finalFillCandidates.map((item) => [item.topic.topic_key, item])).values()]
    .filter((item) => !selected.some((selectedItem) => selectedItem.topic.topic_key === item.topic.topic_key))
    .sort((a, b) => b.score - a.score || a.topic.topic_key.localeCompare(b.topic.topic_key, "ja"));

  for (const item of uniqueFinalFill) {
    if (selected.length >= maxTopics) {
      dropped.push({ topic: item.topic, reason: "topic_count_limit" });
      continue;
    }
    const reason = getTopicNonCategoryLimitReason(item, sourceCounts, snsOnlyCount, lowPriorityCount);
    if (reason) {
      dropped.push({ topic: item.topic, reason });
      continue;
    }
    item.selectionReason = "final_fill";
    addSelectedTopic(item, selected, sourceCounts, categoryCounts);
    if (isSnsOnlySingleEvidence(item.topic)) snsOnlyCount++;
    if (item.representative.isLowPriority) lowPriorityCount++;
  }

  const selectedKeys = new Set(selected.map((item) => item.topic.topic_key));
  const backfillCandidates = eligible
    .filter((item) => !selectedKeys.has(item.topic.topic_key))
    .sort((a, b) => b.score - a.score || a.topic.topic_key.localeCompare(b.topic.topic_key, "ja"));
  return { selected, dropped, backfillCandidates };
}

function addSelectedTopic(
  item: SelectedTopic,
  selected: SelectedTopic[],
  sourceCounts: Map<string, number>,
  categoryCounts: Map<FeedCategory, number>
) {
  selected.push(item);
  sourceCounts.set(item.representative.sourceName, (sourceCounts.get(item.representative.sourceName) ?? 0) + 1);
  categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
}

function getTopicNonCategoryLimitReason(item: SelectedTopic, sourceCounts: Map<string, number>, snsOnlyCount: number, lowPriorityCount: number) {
  if ((sourceCounts.get(item.representative.sourceName) ?? 0) >= MAX_TOPICS_PER_PRIMARY_SOURCE) return "topic_source_limit";
  if (isSnsOnlySingleEvidence(item.topic) && snsOnlyCount >= MAX_SNS_ONLY_TOPICS) return "topic_sns_only_limit";
  if (item.representative.isLowPriority && lowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) return "topic_low_priority_limit";
  return "";
}

function getTopicLimitReason(
  item: SelectedTopic,
  selectedCount: number,
  maxTopics: number,
  sourceCounts: Map<string, number>,
  categoryCounts: Map<FeedCategory, number>,
  snsOnlyCount: number,
  lowPriorityCount: number
) {
  if (selectedCount >= maxTopics) return "topic_count_limit";
  if ((sourceCounts.get(item.representative.sourceName) ?? 0) >= MAX_TOPICS_PER_PRIMARY_SOURCE) return "topic_source_limit";
  if ((categoryCounts.get(item.category) ?? 0) >= (CATEGORY_LIMITS[item.category] ?? 1)) return "topic_category_limit";
  if (isSnsOnlySingleEvidence(item.topic) && snsOnlyCount >= MAX_SNS_ONLY_TOPICS) return "topic_sns_only_limit";
  if (item.representative.isLowPriority && lowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) return "topic_low_priority_limit";
  return "";
}

function getTopicSelectionScore(topic: TopicCandidate, publishableEvidence: RawArticle[]) {
  let score = Math.max(...publishableEvidence.map(getAiInputPriorityScore));
  if (topic.signals.has_multiple_sources) score += 12;
  if (topic.signals.has_official_source && topic.signals.has_media_context) score += 10;
  if (topic.signals.has_hot_search_signal && (topic.signals.has_media_context || topic.signals.has_official_source)) score += 8;
  if (isSnsOnlySingleEvidence(topic)) score = Math.min(score, 55);
  if (publishableEvidence.some(isOfficialCulturalEventWithoutPopSignal)) score = Math.min(score, 55);
  return Math.max(0, Math.min(100, score));
}

function isOfficialCulturalEventWithoutPopSignal(article: RawArticle) {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  return /展演|文联|文化馆|群艺馆|交响|管乐|民乐|合唱|戏曲|京剧|越剧|昆曲|书法|美术展/.test(text) &&
    !/歌手|演唱会|巡演|专辑|单曲|音综|打歌|榜单|音乐节|MV/.test(text);
}

function isSnsOnlySingleEvidence(topic: TopicCandidate) {
  const evidence = topic.evidence_articles;
  return evidence.length === 1 && evidence[0]?.source_type === "sns" && !topic.signals.has_official_source && !topic.signals.has_media_context && !topic.signals.has_data_signal;
}

async function buildTopicEvidenceBundles(selectedTopics: SelectedTopic[], articlePool: RawArticle[]) {
  const articlesByUrl = new Map(articlePool.map((article) => [article.url, article]));
  return Promise.all(selectedTopics.map((item) => buildTopicEvidenceBundle(item, articlePool, articlesByUrl)));
}

async function buildTopicEvidenceBundle(selectedTopic: SelectedTopic, articlePool: RawArticle[], existingMap?: Map<string, RawArticle>) {
  const articlesByUrl = existingMap ?? new Map(articlePool.map((article) => [article.url, article]));
  const evidence = chooseTopicEvidence(selectedTopic, articlesByUrl);
  evidence[0] = await enrichArticleContent(evidence[0]);
  return { topic: selectedTopic.topic, evidence, selectedTopic };
}

function chooseTopicEvidence(item: SelectedTopic, articlesByUrl: Map<string, RawArticle>) {
  const evidenceArticles = item.topic.evidence_articles.map((evidence) => {
    const original = articlesByUrl.get(evidence.url);
    const keyPoints = evidence.key_points.join("\n");
    if (original) {
      return original.url === item.representative.url
        ? original
        : { ...original, rawContent: keyPoints, rawContentLength: keyPoints.length };
    }
    return {
      title: evidence.title,
      url: evidence.url,
      sourceName: evidence.source_name,
      sourceUrl: evidence.url,
      category: item.representative.category,
      reliability: evidence.reliability,
      excerpt: keyPoints,
      rawContent: keyPoints,
      rawContentLength: keyPoints.length,
      articleType: evidence.article_type,
      feedCategory: item.category,
      sourceType: evidence.source_type,
      publishedDate: evidence.published_date,
      freshnessLabel: evidence.freshness_label,
      newsworthinessScore: 0
    } satisfies RawArticle;
  });
  const representative = evidenceArticles.find((article) => article.url === item.representative.url) ?? item.representative;
  const rest = evidenceArticles.filter((article) => article.url !== representative.url);
  const selected = [representative];
  for (const rank of [0, 1, 2, 3, 4]) {
    const candidate = rest
      .filter((article) => getEvidenceTypeRank(article.sourceType) === rank && !selected.some((selectedArticle) => selectedArticle.sourceName === article.sourceName))
      .sort(compareArticlesForAiInput)[0];
    if (candidate && selected.length < 4) selected.push(candidate);
  }
  const remaining = rest
    .filter((article) => !selected.some((selectedArticle) => selectedArticle.url === article.url))
    .sort(compareArticlesForAiInput);
  for (const article of remaining) {
    if (selected.length >= 4) break;
    if (!selected.some((selectedArticle) => selectedArticle.sourceName === article.sourceName)) selected.push(article);
  }
  return selected;
}

function getEvidenceTypeRank(sourceType: SourceTypeLabel | undefined) {
  const ranks: Record<SourceTypeLabel, number> = { official: 0, pr_like: 0, media_report: 1, mixed: 1, data: 2, sns: 3, rumor: 4 };
  return ranks[sourceType ?? "media_report"];
}

function getAiInputPriorityScore(article: RawArticle) {
  let score = article.newsworthinessScore ?? 0;
  const text = article.title + " " + (article.excerpt ?? "");

  if (/\u4e03\u4e00|\u4e3b\u9898\u515a\u65e5|\u515a\u65e5\u6d3b\u52a8|\u515a\u5efa|\u5b66\u4e60\u6559\u80b2/.test(text)) {
    score -= 28;
  }
  if (isFreshUnknownGenerationCandidate(article)) {
    score -= 6;
  }

  return score;
}

function markSelectedTraceReasons(articles: RawArticle[], selectionReasons: Map<string, string>) {
  articles.forEach((article, index) => {
    const freshness = article.freshnessLabel ?? "unknown";
    const priority = article.isLowPriority ? "low_priority" : "normal_priority";
    const score = getAiInputPriorityScore(article);
    selectionReasons.set(candidateKey(article), "rank_" + (index + 1) + ":score_" + score + ":freshness_" + freshness + ":" + priority);
  });
}

function selectArticlesForAi(articles: RawArticle[], maxArticles: number, maxPerSource: number) {
  const selected: RawArticle[] = [];
  const groupedArticles = new Map<FeedCategory, RawArticle[]>();
  for (const article of articles) {
    const category = article.feedCategory ?? "その他";
    const group = groupedArticles.get(category) ?? [];
    group.push(article);
    groupedArticles.set(category, group);
  }

  for (const [category, group] of groupedArticles.entries()) {
    groupedArticles.set(
      category,
      [...group].sort(compareArticlesForAiInput)
    );
  }

  const categories = ROTATION_CATEGORIES;
  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<FeedCategory, number>();
  let lowPriorityCount = 0;
  let cursor = 0;

  while (selected.length < maxArticles) {
    let addedInRound = false;

    for (const category of categories) {
      if (selected.length >= maxArticles) {
        break;
      }

      const categoryLimit = CATEGORY_LIMITS[category] ?? 1;
      const currentCategoryCount = categoryCounts.get(category) ?? 0;
      if (currentCategoryCount >= categoryLimit) {
        continue;
      }

      const group = groupedArticles.get(category) ?? [];
      const article = findNextAllowedArticle(group, cursor, sourceCounts, maxPerSource, lowPriorityCount);
      if (!article) {
        continue;
      }

      selected.push(article);
      sourceCounts.set(article.sourceName, (sourceCounts.get(article.sourceName) ?? 0) + 1);
      categoryCounts.set(category, currentCategoryCount + 1);
      if (article.isLowPriority) {
        lowPriorityCount += 1;
      }
      addedInRound = true;
    }

    if (!addedInRound) {
      break;
    }

    cursor += 1;
  }

  return selected;
}

function findNextAllowedArticle(group: RawArticle[], cursor: number, sourceCounts: Map<string, number>, maxPerSource: number, lowPriorityCount: number) {
  for (let index = cursor; index < group.length; index += 1) {
    const article = group[index];
    if ((sourceCounts.get(article.sourceName) ?? 0) >= maxPerSource) {
      continue;
    }
    if (article.isLowPriority && lowPriorityCount >= MAX_LOW_PRIORITY_ARTICLES) {
      continue;
    }
    return article;
  }
  return undefined;
}

function isTooThinForPublishing(article: RawArticle) {
  const rawContentLength = article.rawContentLength ?? 0;
  if (article.articleType === "official_announcement" || article.reliability === "A") {
    return rawContentLength < MIN_OFFICIAL_RAW_CONTENT_LENGTH;
  }
  return rawContentLength < MIN_RAW_CONTENT_LENGTH;
}

function enrichDiagnostics(diagnostics: SourceDiagnostic[], dedupedArticles: RawArticle[], selectedArticles: RawArticle[]) {
  const dedupedCounts = countBySource(dedupedArticles);
  const selectedCounts = countBySource(selectedArticles);

  return diagnostics
    .map((diagnostic) => ({
      ...diagnostic,
      dedupedCount: dedupedCounts.get(diagnostic.sourceName) ?? 0,
      selectedForAiCount: selectedCounts.get(diagnostic.sourceName) ?? 0
    }))
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName, "ja"));
}

function countBySource(articles: RawArticle[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    counts.set(article.sourceName, (counts.get(article.sourceName) ?? 0) + 1);
  }
  return counts;
}

function logSourceDiagnostics(diagnostics: SourceDiagnostic[]) {
  console.log("");
  console.log("source別取得診断");
  for (const diagnostic of diagnostics) {
    console.log(`- ${diagnostic.sourceName}`);
    console.log(`  取得件数: ${diagnostic.fetchedCount}`);
    console.log(`  excludeUrlPatterns除外: ${diagnostic.excludedByPatternCount}`);
    console.log(`  重複除去後: ${diagnostic.dedupedCount}`);
    console.log(`  AI処理対象: ${diagnostic.selectedForAiCount}`);
    console.log(`  エラー: ${diagnostic.error ?? "なし"}`);
    console.log(`  代表タイトル: ${diagnostic.sampleTitles.length ? diagnostic.sampleTitles.join(" / ") : "なし"}`);
  }
}

function logArticleTypeCounts(articles: RawArticle[]) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    const type = article.articleType ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  console.log("");
  console.log("articleType別件数");
  for (const [type, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${type}: ${count}件`);
  }
}

function logMetadataCounts(articles: RawArticle[]) {
  logFieldCounts("badge別件数", articles.map((article) => article.badge ?? "NEWS"));
  logFieldCounts("source_type別件数", articles.map((article) => article.sourceType ?? "media_report"));
  logFieldCounts("freshness_label別件数", articles.map((article) => article.freshnessLabel ?? "unknown"));

  console.log("");
  console.log("newsworthiness_score 上位記事");
  for (const article of [...articles].sort((a, b) => (b.newsworthinessScore ?? 0) - (a.newsworthinessScore ?? 0)).slice(0, 8)) {
    console.log(`- ${article.newsworthinessScore ?? 0}: ${article.title}`);
  }
}

function logFieldCounts(title: string, values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  console.log("");
  console.log(title);
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${value}: ${count}件`);
  }
}

function logDuplicateCandidates(candidates: Array<{ topicKey: string; titles: string[]; sources: string[] }>) {
  console.log("");
  console.log(`重複候補: ${candidates.length}件`);
  for (const candidate of candidates) {
    console.log(`- ${candidate.topicKey}: ${candidate.sources.join(" / ")}`);
    for (const title of candidate.titles.slice(0, 3)) {
      console.log(`  - ${title}`);
    }
  }
}

function logSourceExpansion(expansion: Awaited<ReturnType<typeof expandTopicSources>>["expansion"]) {
  console.log("");
  console.log("source expansion");
  console.log(`- attempted topics: ${expansion.attempted_topic_count}`);
  console.log(`- attempted routes: ${expansion.attempted_route_count}`);
  console.log(`- success routes: ${expansion.success_route_count}`);
  console.log(`- evidence: ${expansion.evidence_count}`);
  for (const attempt of expansion.attempts.slice(0, 12)) {
    console.log(
      `- ${attempt.route_id} ${attempt.fetch_status}: topic=${attempt.topic_key} query=${attempt.query} raw=${attempt.raw_count} matched=${attempt.matched_count}${attempt.failure_stage ? ` stage=${attempt.failure_stage}` : ""}`
    );
  }
}

function logExclusions(title: string, exclusions: Array<{ title: string; type: ArticleType; reason: string }>) {
  console.log("");
  console.log(`${title}: ${exclusions.length}件`);
  for (const exclusion of exclusions) {
    console.log(`- 除外: ${exclusion.reason} - ${exclusion.title}`);
  }
}

function logFinalSourceDistribution(articles: RawArticle[], heading = "最終AI処理対象のsource配分") {
  const counts = [...countBySource(articles).entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));

  console.log("");
  console.log(heading);
  if (!counts.length) {
    console.log("- なし");
    return;
  }

  for (const [sourceName, count] of counts) {
    console.log(`- ${sourceName}: ${count}件`);
  }
}

function logFinalCategoryDistribution(articles: RawArticle[], heading: string) {
  const counts = new Map<string, number>();
  for (const article of articles) {
    const category = article.feedCategory ?? article.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  console.log("");
  console.log(heading);
  if (!counts.size) {
    console.log("- なし");
    return;
  }

  for (const [category, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"))) {
    console.log(`- ${category}: ${count}件`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`実行に失敗しました: ${message}`);
  process.exitCode = 1;
});
