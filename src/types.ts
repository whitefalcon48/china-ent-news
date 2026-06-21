export type SourceType = "rss" | "html";
export type Reliability = "A" | "B" | "C" | "D";
export type AiProvider = "gemini" | "deepseek";
export type FeedCategory = "映画" | "ドラマ・配信" | "芸能・俳優" | "業界動向" | "公式発表" | "海外中国映画祭・文化交流" | "その他";
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

export type SourceDiagnostic = {
  sourceName: string;
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
};

export type SummarizedArticle = {
  title_ja: string;
  lead: string;
  what_happened: string;
  reaction_view: string;
  editor_note: string;
  category: string;
  confidence: Reliability;
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
