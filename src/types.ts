export type SourceType = "rss" | "html";
export type Reliability = "A" | "B" | "C" | "D";
export type AiProvider = "gemini" | "deepseek";
export type FeedCategory = "映画" | "ドラマ・配信" | "芸能・俳優" | "業界動向" | "公式発表" | "その他";
export type FeedBadge = "NEWS" | "HOT SEARCH" | "WATCH" | "OFFICIAL" | "DATA" | "PR WATCH";
export type SourceTypeLabel = "official" | "media_report" | "sns" | "data" | "pr_like" | "rumor" | "mixed";
export type FreshnessLabel = "today" | "yesterday" | "recent" | "stale" | "old" | "unknown" | "background";
export type LevelLabel = "high" | "medium" | "low" | "unknown";
export type ContextValue = "high" | "medium" | "low";
export type SnsHeat = "high" | "medium" | "low" | "none";
export type PublishPriority = "high" | "medium" | "low";
export type TopicType =
  | "release"
  | "box_office"
  | "casting"
  | "award"
  | "policy"
  | "drama_production"
  | "platform_trend"
  | "fan_culture"
  | "gossip_rumor"
  | "cultural_export"
  | "industry_context"
  | "unknown";
export type ArticleType =
  | "news_event"
  | "official_announcement"
  | "data_report"
  | "gossip_rumor"
  | "sns_trend"
  | "column_opinion"
  | "review"
  | "interview"
  | "static_page"
  | "unknown";

export type NewsSource = {
  name: string;
  url: string;
  type: SourceType;
  category: string;
  reliability: Reliability;
  sourceType?: SourceTypeLabel;
  enabled?: boolean;
  includeUrlPatterns?: string[];
  excludeUrlPatterns?: string[];
  requireEntertainmentKeywords?: boolean;
};

export type DateSource = "rss" | "url" | "html" | "unknown";

export type AuditExcludeStage =
  | ""
  | "url_exclude"
  | "dedupe"
  | "date_unknown"
  | "freshness_stale"
  | "freshness_old"
  | "before_2026"
  | "article_type_exclude";

export type SourceAuditSample = {
  title: string;
  url: string;
  excludeStage: AuditExcludeStage;
  excludeReason: string;
};

export type SourceDiagnostic = {
  sourceName: string;
  rawCount?: number;
  afterUrlExcludeCount?: number;
  fetchedCount: number;
  excludedByPatternCount: number;
  dedupedCount: number;
  selectedForAiCount: number;
  error?: string;
  sampleTitles: string[];
  auditSamples?: SourceAuditSample[];
};

export type RawArticle = {
  title: string;
  url: string;
  sourceName: string;
  sourceUrl: string;
  category: string;
  reliability: Reliability;
  declaredSourceType?: SourceTypeLabel;
  publishedAt?: string;
  publishedAtSource?: DateSource;
  excerpt?: string;
  rawContent?: string;
  rawContentLength?: number;
  articleType?: ArticleType;
  skipReason?: string;
  topicKey?: string;
  mainEntities?: MainEntities;
  relatedSources?: SourceRef[];
  feedCategory?: FeedCategory;
  isLowPriority?: boolean;
  badge?: FeedBadge;
  sourceType?: SourceTypeLabel;
  publishedDate?: string;
  eventDate?: string;
  freshnessLabel?: FreshnessLabel;
  dateSource?: DateSource;
  ageDays?: number;
  dateExtractionNote?: string;
  newsworthinessScore?: number;
  japanVisibility?: LevelLabel;
  japanGap?: LevelLabel;
  contextValue?: ContextValue;
  snsHeat?: SnsHeat;
};

export type SummarizedArticle = {
  title_ja: string;
  badge: FeedBadge;
  lead: string;
  what_happened: string;
  why_it_matters: string;
  reaction_view: string;
  editor_comment: string;
  japan_context_note: string;
  category: string;
  confidence: Reliability;
  source_type: SourceTypeLabel;
  published_date: string;
  event_date: string;
  freshness_label: FreshnessLabel;
  newsworthiness_score: number;
  japan_visibility: LevelLabel;
  japan_gap: LevelLabel;
  context_value: ContextValue;
  sns_heat: SnsHeat;
  source_count: number;
  source_list: SourceRef[];
  has_official_source: boolean;
  has_multiple_sources: boolean;
  has_sns_signal: boolean;
  article_type: ArticleType;
  skip_reason: string;
  verification_status: string;
  topic_key: string;
  main_entities: MainEntities;
  related_sources: SourceRef[];
  tags: string[];
  publish_priority: PublishPriority;
  publish_reason: string;
  claim_refs: ClaimRefs;
};

export type SourceRef = {
  name: string;
  url?: string;
};

export type MainEntities = {
  people: string[];
  works: string[];
  organizations: string[];
};

export type ClaimType = "verified_fact" | "source_analysis" | "unsupported";

export type FactLedgerClaim = {
  id: string;
  type: ClaimType;
  text: string;
  evidence_refs: string[];
  source_name?: string;
  entities: string[];
  numbers: string[];
  quote_zh?: string;
};

export type FactLedgerTerm = { term: string; gloss_ja: string; what_is?: string; why_now?: string };

export type ToneMode = "normal" | "sober";

export type JapanAvailability = {
  status: "verified" | "not_in_evidence";
  detail: string;
  evidence_refs: string[];
};

export type FactLedger = {
  topic_key: string;
  claims: FactLedgerClaim[];
  terms: FactLedgerTerm[];
  japan_availability: JapanAvailability;
  unresolved: string[];
};

export type ClaimRefs = {
  what_happened: string[];
  why_it_matters: string[];
  reaction_view: string[];
  japan_context_note: string[];
};

export type ClaimCheckRule =
  | "japan_availability_unverified"
  | "predictive_assertion_certain"
  | "number_not_in_ledger"
  | "entity_not_in_ledger"
  | "unsupported_generalization"
  | "japan_comparison_no_claim"
  | "unattributed_analysis"
  | "generic_comment"
  | "banned_phrase_other"
  | "fabricated_reaction"
  | "unverified_speculation"
  | "template_comment"
  | "tone_exclamation"
  | "ending_repetition"
  | "hedged_verified_fact"
  | "long_sentence"
  | "terminology_avoid";

export type ClaimCheckViolation = {
  section: string;
  rule: ClaimCheckRule;
  severity: "gate" | "warning";
  detail: string;
};

export type ClaimCheckResult = {
  topic_key: string;
  violations: ClaimCheckViolation[];
  gated_violation_count: number;
  action: "none" | "text_removed" | "regenerated" | "discarded";
};

export type TopicGenerationMeta = {
  topic_key: string;
  ledger_used: boolean;
  ledger_fallback_reason: string;
  ledger?: FactLedger;
  claim_check?: ClaimCheckResult;
  tone_mode?: ToneMode;
  comment_stage?: {
    attempted: boolean;
    used: boolean;
    regenerated: boolean;
    fallback_reason: string;
    exclamation_count: number;
  };
};

export type ReviewStatus = "pending" | "completed";
export type ReviewArticleStatus = "pending" | "approved" | "rejected" | "revision_requested" | "revised_pending";
export type ReviewReasonTag = "" | "選定" | "口調" | "用語" | "事実" | "構成" | "その他";

export type ReviewArticle = {
  index: number;
  topic_key: string;
  title: string;
  status: ReviewArticleStatus;
  reason_tag: ReviewReasonTag;
  comment: string;
  revision_count: number;
};

export type ReviewState = {
  date: string;
  status: ReviewStatus;
  issue_number: number;
  articles: ReviewArticle[];
};

export type ReviewFeedback = {
  date: string;
  topic_key: string;
  action: "rejected" | "revision_requested";
  reason_tag: Exclude<ReviewReasonTag, "">;
  comment: string;
  category: string;
  topic_type: string;
  seed_confidence: number;
  newsworthiness_score: number;
  publish_priority: string;
  selection_reason: string;
  source_mix: Partial<Record<SourceTypeLabel, number>>;
};

export type ProcessedArticle = {
  raw: RawArticle;
  summary?: SummarizedArticle;
  aiError?: string;
  topic?: TopicCandidate;
  generationMeta?: TopicGenerationMeta;
};

export type TopicCandidate = {
  topic_key: string;
  title_hint: string;
  event_sentence: string;
  search_queries: string[];
  seed_source: "llm" | "regex_fallback";
  seed_confidence: number;
  topic_type: TopicType;
  freshness_label: FreshnessLabel;
  published_date_range: {
    earliest: string;
    latest: string;
  };
  source_count: number;
  source_mix: Record<SourceTypeLabel, number>;
  evidence_articles: Array<{
    title: string;
    url: string;
    source_name: string;
    source_type: SourceTypeLabel;
    published_date: string;
    freshness_label: FreshnessLabel;
    article_type: ArticleType;
    reliability: Reliability;
    key_points: string[];
  }>;
  main_entities: MainEntities & {
    events: string[];
  };
  signals: {
    has_official_source: boolean;
    has_media_context: boolean;
    has_data_signal: boolean;
    has_hot_search_signal: boolean;
    has_multiple_sources: boolean;
  };
  newsworthiness_score: number;
  japan_gap: LevelLabel;
  context_value: ContextValue;
  publish_priority: PublishPriority;
  selection_reason: string;
  caution_note: string;
};

export type SourceExpansionEvidence = {
  title: string;
  url: string;
  source_name: string;
  source_type: SourceTypeLabel;
  route_id: string;
  route: string;
  query: string;
  key_points: string[];
};

export type SourceExpansionAttempt = {
  topic_key: string;
  query: string;
  route_id: string;
  route: string;
  rsshub_base_url: string;
  fetch_status: "success" | "failed" | "empty" | "skipped";
  fetch_error: string;
  raw_count: number;
  matched_count: number;
  failure_stage: string;
  source_type: SourceTypeLabel;
};

export type SourceExpansionResult = {
  attempted_topic_count: number;
  attempted_route_count: number;
  success_route_count: number;
  evidence_count: number;
  attempts: SourceExpansionAttempt[];
  evidence: SourceExpansionEvidence[];
};

export type TopicSeed = {
  article_url: string;
  article_title: string;
  fallback_topic_key: string;
  topic_key: string;
  event_sentence: string;
  entities: MainEntities & {
    events: string[];
  };
  search_queries: string[];
  confidence: number;
  source: "llm" | "regex_fallback";
  error?: string;
};

export type TopicSeedExtractionResult = {
  provider: AiProvider;
  attempted: boolean;
  succeeded: boolean;
  error: string;
  chunk_count: number;
  failed_chunk_count: number;
  seeds: TopicSeed[];
};

export type ArticleFilterConfig = {
  excludeArticleTypes: ArticleType[];
  columnOpinionKeywords: string[];
  reviewKeywords: string[];
  interviewKeywords: string[];
  staticPageKeywords: string[];
  snsTrendKeywords: string[];
  gossipRumorKeywords: string[];
  dataReportKeywords: string[];
  officialAnnouncementKeywords: string[];
};
