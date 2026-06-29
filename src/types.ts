export type SourceType = "rss" | "html";
export type Reliability = "A" | "B" | "C" | "D";
export type AiProvider = "gemini" | "deepseek";
export type FeedCategory = "映画" | "ドラマ・配信" | "芸能・俳優" | "業界動向" | "公式発表" | "海外中国映画祭・文化交流" | "その他";
export type FeedBadge = "NEWS" | "HOT SEARCH" | "WATCH" | "OFFICIAL" | "DATA" | "PR WATCH";
export type SourceTypeLabel = "official" | "media_report" | "sns" | "data" | "pr_like" | "rumor" | "mixed";
export type FreshnessLabel = "today" | "yesterday" | "recent" | "stale" | "old" | "unknown" | "background";
export type LevelLabel = "high" | "medium" | "low" | "unknown";
export type ContextValue = "high" | "medium" | "low";
export type SnsHeat = "high" | "medium" | "low" | "none";
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
  enabled?: boolean;
  includeUrlPatterns?: string[];
  excludeUrlPatterns?: string[];
};

export type DateSource = "rss" | "url" | "html" | "unknown";

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
};

export type RawArticle = {
  title: string;
  url: string;
  sourceName: string;
  sourceUrl: string;
  category: string;
  reliability: Reliability;
  publishedAt?: string;
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

export type ProcessedArticle = {
  raw: RawArticle;
  summary?: SummarizedArticle;
  aiError?: string;
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
