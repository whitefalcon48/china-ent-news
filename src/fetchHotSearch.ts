import { auditHotSearchSources, type HotSearchAuditResult } from "./auditHotSearch.js";
import type { RawArticle } from "./types.js";

const MAX_HOT_SEARCH_ARTICLES = 15;

export type HotSearchFetchResult = {
  articles: RawArticle[];
  statusLines: string[];
};

// Promotes the RSSHub hot-search diagnostics into generation candidates.
// Only entertainment-matching items become articles; every route failure is
// reported as a status line instead of aborting the run (graceful fallback).
export async function fetchHotSearchArticles(): Promise<HotSearchFetchResult> {
  const results = await auditHotSearchSources();
  const articles: RawArticle[] = [];
  const statusLines: string[] = [];

  for (const result of results) {
    statusLines.push(describeRouteStatus(result));
    if (result.fetch_status !== "success") {
      continue;
    }

    for (const item of result.sample_items) {
      if (articles.length >= MAX_HOT_SEARCH_ARTICLES) {
        break;
      }
      if (!item.entertainment_match_reason || !item.title || !item.url) {
        continue;
      }
      articles.push({
        title: item.title,
        url: item.url,
        sourceName: "微博热搜",
        sourceUrl: result.rsshub_base_url + result.route,
        category: "SNSトレンド",
        reliability: "C",
        declaredSourceType: "sns",
        publishedAt: new Date().toISOString(),
        publishedAtSource: "rss",
        excerpt: [item.description, item.hot_value ? `热度: ${item.hot_value}` : "", `热搜排名: ${item.rank ?? "?"}`]
          .filter(Boolean)
          .join(" / ")
      });
    }
  }

  return { articles, statusLines };
}

function describeRouteStatus(result: HotSearchAuditResult) {
  const base = `HOT SEARCH ${result.route || "not_configured"}: ${result.fetch_status}`;
  if (result.fetch_status === "success") {
    return `${base} (raw: ${result.raw_count}, entertainment_like: ${result.entertainment_like_count})`;
  }
  if (result.fetch_status === "not_configured") {
    return `${base} (${result.failure_stage})`;
  }
  return `${base} (${result.failure_stage}${result.fetch_error ? `: ${result.fetch_error}` : ""})`;
}
