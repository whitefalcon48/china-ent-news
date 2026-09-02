import { enrichArticleContent, enrichArticlesContent } from "../fetchSources.js";
import type { ProcessedArticle, RawArticle } from "../types.js";

export async function rebuildReviewEvidence(
  article: ProcessedArticle,
  enrich: (article: RawArticle) => Promise<RawArticle> = enrichArticleContent
) {
  const topic = article.topic;
  if (!topic?.evidence_articles.length) {
    return article.raw.rawContent
      ? [article.raw]
      : enrichArticlesContent([article.raw], enrich);
  }

  const evidence = topic.evidence_articles.map((item) => item.url === article.raw.url
    ? article.raw
    : ({
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
      } satisfies RawArticle));

  // Keep already archived bodies unchanged. Only fetch evidence that was
  // previously stored as a headline or short excerpt.
  return enrichArticlesContent(evidence, (item) => item.rawContent ? Promise.resolve(item) : enrich(item));
}
