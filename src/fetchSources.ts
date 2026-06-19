import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import type { NewsSource, RawArticle } from "./types.js";

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
  const batches = await Promise.all(
    sources.map(async (source) => {
      try {
        return await fetchSource(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.name}: ${message}`);
        return [];
      }
    })
  );

  return {
    articles: batches.flat(),
    errors
  };
}

async function fetchSource(source: NewsSource): Promise<RawArticle[]> {
  if (source.type === "rss") {
    return fetchRssSource(source);
  }
  return fetchHtmlSource(source);
}

async function fetchRssSource(source: NewsSource): Promise<RawArticle[]> {
  const parser = new Parser();
  const feed = await parser.parseURL(source.url);

  return feed.items
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
    .filter((article) => article.title && article.url)
    .filter(isLikelyEntertainmentArticle)
    .slice(0, 20);
}

async function fetchHtmlSource(source: NewsSource): Promise<RawArticle[]> {
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

  $("a").each((_, element) => {
    const title = cleanText($(element).text());
    const href = $(element).attr("href");

    if (!title || !href || title.length < 8) {
      return;
    }

    const url = toAbsoluteUrl(href, source.url);
    if (!url || seen.has(url)) {
      return;
    }

    if (!matchesIncludePatterns(url, source.includeUrlPatterns)) {
      return;
    }

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

    seen.add(url);
    articles.push(article);
  });

  return articles.slice(0, 20);
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
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

function matchesIncludePatterns(url: string, patterns?: string[]) {
  if (!patterns?.length) {
    return true;
  }

  return patterns.some((pattern) => url.includes(pattern));
}
