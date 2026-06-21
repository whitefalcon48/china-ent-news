export type SourceType = "rss" | "html";
export type Reliability = "A" | "B" | "C" | "D";
export type AiProvider = "gemini" | "deepseek";

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
};

export type SummarizedArticle = {
  title_ja: string;
  summary_bullets: string[];
  category: string;
  confidence: Reliability;
  confirmed_facts: string[];
  reported_claims: string[];
  sns_reactions: string[];
  unverified_points: string[];
  multiple_viewpoints: string[];
  body_ja: string;
  source_notes: string;
  tags: string[];
};

export type ProcessedArticle = {
  raw: RawArticle;
  summary?: SummarizedArticle;
  aiError?: string;
};
