import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import type { NewsSource, RawArticle, SourceDiagnostic } from "./types.js";

const ENTERTAINMENT_KEYWORDS = [
  "电影",
  "影片",
  "票房",
  "影院",
  "导演",
  "演员",
  "电视剧",
  "剧集",
  "综艺",
  "文娱",
  "影视",
  "明星",
  "艺人",
  "广播电视"
];

export async function loadSources(configPath = "config/sources.json"): Promise<NewsSource[]> {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const sources = JSON.parse(raw) as NewsSource[];
  return sources.filter((source) => source.enabled !== false);
}

export async function fetchAllSources(sources: NewsSource[]) {
  const errors: string[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const batches = await Promise.all(
    sources.map(async (source) => {
      try {
        const result = await fetchSource(source);
        diagnostics.push(result.diagnostic);
        return result.articles;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.name}: ${message}`);
        diagnostics.push({
          sourceName: source.name,
          rawCount: 0,
          afterUrlExcludeCount: 0,
          fetchedCount: 0,
          excludedByPatternCount: 0,
          dedupedCount: 0,
          selectedForAiCount: 0,
          error: message,
          sampleTitles: []
        });
        return [];
      }
    })
  );

  return {
    articles: batches.flat(),
    errors,
    diagnostics
  };
}

export async function enrichArticleContent(article: RawArticle): Promise<RawArticle> {
  try {
    const response = await fetch(article.url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase0/0.1)"
      }
    });

    if (!response.ok) {
      return withRawContent(article, article.excerpt ?? "");
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer, aside, form").remove();
    const candidates = [
      "article",
      ".article",
      ".article-content",
      ".content",
      ".main-content",
      ".detail",
      ".text",
      ".TRS_Editor",
      "#artibody",
      "body"
    ];

    const texts = candidates
      .map((selector) => cleanText($(selector).text()))
      .filter((text) => text.length > 80)
      .sort((a, b) => b.length - a.length);

    return withRawContent(article, texts[0] ?? article.excerpt ?? "");
  } catch {
    return withRawContent(article, article.excerpt ?? "");
  }
}

async function fetchSource(source: NewsSource): Promise<{ articles: RawArticle[]; diagnostic: SourceDiagnostic }> {
  if (source.type === "rss") {
    return fetchRssSource(source);
  }
  return fetchHtmlSource(source);
}

async function fetchRssSource(source: NewsSource): Promise<{ articles: RawArticle[]; diagnostic: SourceDiagnostic }> {
  const parser = new Parser();
  const feed = await parser.parseURL(source.url);
  let excludedByPatternCount = 0;

  const rawArticles = feed.items
    .map((item) => ({
      title: cleanText(item.title ?? ""),
      url: item.link ?? "",
      sourceName: source.name,
      sourceUrl: source.url,
      category: source.category,
      reliability: source.reliability,
      publishedAt: item.isoDate ?? item.pubDate,
      excerpt: cleanText(item.contentSnippet ?? item.summary ?? "")
    }))
    .filter((article) => article.title && article.url);

  const afterUrlExcludeArticles = rawArticles.filter((article) => {
    if (!matchesIncludePatterns(article.url, source.includeUrlPatterns)) {
      return false;
    }
    if (matchesExcludePatterns(article.url, source.excludeUrlPatterns)) {
      excludedByPatternCount += 1;
      return false;
    }
    return true;
  });

  const articles = afterUrlExcludeArticles.filter(isLikelyEntertainmentArticle).slice(0, 20);

  return {
    articles,
    diagnostic: buildDiagnostic(source.name, articles, excludedByPatternCount, rawArticles.length, afterUrlExcludeArticles.length)
  };
}

async function fetchHtmlSource(source: NewsSource): Promise<{ articles: RawArticle[]; diagnostic: SourceDiagnostic }> {
  const response = await fetch(source.url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase0/0.1)"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const articles: RawArticle[] = [];
  let rawCount = 0;
  let afterUrlExcludeCount = 0;
  let excludedByPatternCount = 0;

  $("a").each((_, element) => {
    const title = cleanText($(element).text());
    const href = $(element).attr("href");

    if (!title || !href || title.length < 8 || isBadTitle(title)) {
      return;
    }

    const url = toAbsoluteUrl(href, source.url);
    if (!url || seen.has(url)) {
      return;
    }

    seen.add(url);
    rawCount += 1;

    if (!matchesIncludePatterns(url, source.includeUrlPatterns)) {
      return;
    }

    if (matchesExcludePatterns(url, source.excludeUrlPatterns)) {
      excludedByPatternCount += 1;
      return;
    }

    afterUrlExcludeCount += 1;

    const article: RawArticle = {
      title,
      url,
      sourceName: source.name,
      sourceUrl: source.url,
      category: source.category,
      reliability: source.reliability
    };

    if (!isLikelyEntertainmentArticle(article)) {
      return;
    }

    articles.push(article);
  });

  const limitedArticles = articles.slice(0, 20);

  return {
    articles: limitedArticles,
    diagnostic: buildDiagnostic(source.name, limitedArticles, excludedByPatternCount, rawCount, afterUrlExcludeCount)
  };
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function withRawContent(article: RawArticle, rawContent: string): RawArticle {
  const cleaned = cleanText(rawContent);
  return {
    ...article,
    rawContent: cleaned.slice(0, 5000),
    rawContentLength: cleaned.length
  };
}

function toAbsoluteUrl(href: string, baseUrl: string) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function isLikelyEntertainmentArticle(article: RawArticle) {
  const haystack = `${article.title} ${article.excerpt ?? ""}`;
  return ENTERTAINMENT_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function isBadTitle(title: string) {
  return /document\.write|_docTitle|function\s*\(|var\s+|replace\(|window\.|<script/i.test(title);
}

function matchesIncludePatterns(url: string, patterns?: string[]) {
  if (!patterns?.length) {
    return true;
  }

  return patterns.some((pattern) => url.includes(pattern));
}

function matchesExcludePatterns(url: string, patterns?: string[]) {
  if (!patterns?.length) {
    return false;
  }

  return patterns.some((pattern) => url.includes(pattern));
}

function buildDiagnostic(sourceName: string, articles: RawArticle[], excludedByPatternCount: number, rawCount = articles.length, afterUrlExcludeCount = articles.length): SourceDiagnostic {
  return {
    sourceName,
    rawCount,
    afterUrlExcludeCount,
    fetchedCount: articles.length,
    excludedByPatternCount,
    dedupedCount: 0,
    selectedForAiCount: 0,
    sampleTitles: articles.slice(0, 3).map((article) => article.title)
  };
}
