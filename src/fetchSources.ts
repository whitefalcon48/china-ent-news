import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import type { AuditExcludeStage, NewsSource, RawArticle, SourceAuditSample, SourceDiagnostic } from "./types.js";

const ENTERTAINMENT_KEYWORDS = [
  "\u7535\u5f71",
  "\u5f71\u7247",
  "\u7968\u623f",
  "\u5f71\u9662",
  "\u5bfc\u6f14",
  "\u6f14\u5458",
  "\u7535\u89c6\u5267",
  "\u5267\u96c6",
  "\u7efc\u827a",
  "\u6587\u5a31",
  "\u5f71\u89c6",
  "\u660e\u661f",
  "\u827a\u4eba",
  "\u5e7f\u64ad\u7535\u89c6"
];

const PAGE_DATE_META_KEYS = [
  "article:published_time",
  "article:modified_time",
  "pubdate",
  "publishdate",
  "publish_date",
  "date",
  "dc.date",
  "dc.date.issued",
  "weibo:article:create_at",
  "og:release_date"
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
          sampleTitles: [],
          auditSamples: []
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
    const publishedAt = extractPublishedDateFromPage($, html) || article.publishedAt;
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

    return withRawContent({ ...article, publishedAt, publishedAtSource: publishedAt ? "html" : article.publishedAtSource }, texts[0] ?? article.excerpt ?? "");
  } catch {
    return withRawContent(article, article.excerpt ?? "");
  }
}

export async function enrichArticleMetadata(article: RawArticle): Promise<RawArticle> {
  try {
    const response = await fetch(article.url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase0/0.1)"
      }
    });

    if (!response.ok) {
      return { ...article, dateExtractionNote: `article_html_http_${response.status}` };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const publishedAt = extractPublishedDateFromPage($, html);
    if (publishedAt) {
      return { ...article, publishedAt, publishedAtSource: "html", dateExtractionNote: "html_date_found" };
    }

    return { ...article, dateExtractionNote: "no_meta_jsonld_or_page_time_found" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...article, dateExtractionNote: `article_html_fetch_failed: ${message}` };
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
  const auditSamples: SourceAuditSample[] = [];

  const rawArticles = feed.items
    .map((item) => ({
      title: cleanText(item.title ?? ""),
      url: item.link ?? "",
      sourceName: source.name,
      sourceUrl: source.url,
      category: source.category,
      reliability: source.reliability,
      publishedAt: item.isoDate ?? item.pubDate,
      publishedAtSource: item.isoDate || item.pubDate ? ("rss" as const) : undefined,
      excerpt: cleanText(item.contentSnippet ?? item.summary ?? "")
    }))
    .filter((article) => article.title && article.url);

  const afterUrlExcludeArticles = rawArticles.filter((article) => {
    if (!matchesIncludePatterns(article.url, source.includeUrlPatterns)) {
      pushAuditSample(auditSamples, article.title, article.url, "url_exclude", "includeUrlPatterns_no_match");
      return false;
    }
    if (matchesExcludePatterns(article.url, source.excludeUrlPatterns)) {
      excludedByPatternCount += 1;
      pushAuditSample(auditSamples, article.title, article.url, "url_exclude", "excludeUrlPatterns_match");
      return false;
    }
    return true;
  });

  const articles = afterUrlExcludeArticles.filter((article) => {
    if (!isLikelyEntertainmentArticle(article)) {
      pushAuditSample(auditSamples, article.title, article.url, "article_type_exclude", "not_entertainment_keyword");
      return false;
    }
    return true;
  }).slice(0, 20);

  return {
    articles,
    diagnostic: buildDiagnostic(source.name, articles, excludedByPatternCount, rawArticles.length, afterUrlExcludeArticles.length, auditSamples)
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
  const auditSamples: SourceAuditSample[] = [];
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
      pushAuditSample(auditSamples, title, url, "url_exclude", "includeUrlPatterns_no_match");
      return;
    }

    if (matchesExcludePatterns(url, source.excludeUrlPatterns)) {
      excludedByPatternCount += 1;
      pushAuditSample(auditSamples, title, url, "url_exclude", "excludeUrlPatterns_match");
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
      pushAuditSample(auditSamples, title, url, "article_type_exclude", "not_entertainment_keyword");
      return;
    }

    articles.push(article);
  });

  const limitedArticles = articles.slice(0, 20);

  return {
    articles: limitedArticles,
    diagnostic: buildDiagnostic(source.name, limitedArticles, excludedByPatternCount, rawCount, afterUrlExcludeCount, auditSamples)
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

function buildDiagnostic(
  sourceName: string,
  articles: RawArticle[],
  excludedByPatternCount: number,
  rawCount = articles.length,
  afterUrlExcludeCount = articles.length,
  auditSamples: SourceAuditSample[] = []
): SourceDiagnostic {
  return {
    sourceName,
    rawCount,
    afterUrlExcludeCount,
    fetchedCount: articles.length,
    excludedByPatternCount,
    dedupedCount: 0,
    selectedForAiCount: 0,
    sampleTitles: articles.slice(0, 3).map((article) => article.title),
    auditSamples: pickDiagnosticAuditSamples(auditSamples)
  };
}

function pickDiagnosticAuditSamples(samples: SourceAuditSample[]) {
  const selected: SourceAuditSample[] = [];
  const seen = new Set<string>();
  const add = (sample: SourceAuditSample) => {
    const key = `${sample.excludeStage}:${sample.excludeReason}:${sample.url}`;
    if (seen.has(key) || selected.length >= 60) {
      return;
    }
    selected.push(sample);
    seen.add(key);
  };

  for (const stage of ["article_type_exclude", "url_exclude"] as AuditExcludeStage[]) {
    for (const sample of samples.filter((item) => item.excludeStage === stage).slice(0, 30)) {
      add(sample);
    }
  }

  for (const sample of samples) {
    add(sample);
  }

  return selected;
}

function pushAuditSample(samples: SourceAuditSample[], title: string, url: string, excludeStage: AuditExcludeStage, excludeReason: string) {
  const sameStageCount = samples.filter((sample) => sample.excludeStage === excludeStage).length;
  const maxPerStage = excludeStage === "url_exclude" ? 30 : 20;
  if (sameStageCount >= maxPerStage || samples.length >= 80) {
    return;
  }
  samples.push({ title, url, excludeStage, excludeReason });
}

function extractPublishedDateFromPage($: cheerio.CheerioAPI, html: string) {
  const attributeDate = extractAttributeTimestampDate($, html);
  if (attributeDate) {
    return attributeDate;
  }

  const metaDate = extractMetaDate($);
  if (metaDate) {
    return metaDate;
  }

  const jsonLdDate = extractJsonLdDate($);
  if (jsonLdDate) {
    return jsonLdDate;
  }

  return extractPageTextDate($, html);
}

function extractAttributeTimestampDate($: cheerio.CheerioAPI, html: string) {
  const attrValue = $("[data-article-publish-time]").first().attr("data-article-publish-time") ?? "";
  const attrDate = normalizeUnixTimestamp(attrValue);
  if (attrDate) {
    return attrDate;
  }

  const htmlMatch = html.match(/data-article-publish-time=["']?(\d{10,13})/i)?.[1] ?? "";
  return normalizeUnixTimestamp(htmlMatch);
}

function normalizeUnixTimestamp(value: string) {
  if (!/^\d{10,13}$/.test(value)) {
    return "";
  }
  const numeric = Number(value.length === 13 ? value : `${value}000`);
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function extractMetaDate($: cheerio.CheerioAPI) {
  for (const key of PAGE_DATE_META_KEYS) {
    const selectors = [
      `meta[property="${key}"]`,
      `meta[name="${key}"]`,
      `meta[itemprop="${key}"]`
    ];
    for (const selector of selectors) {
      const value = $(selector).attr("content");
      const date = normalizeDateString(value ?? "");
      if (date) {
        return date;
      }
    }
  }

  const timeDate = normalizeDateString($("time[datetime]").first().attr("datetime") ?? "");
  if (timeDate) {
    return timeDate;
  }

  return "";
}

function extractJsonLdDate($: cheerio.CheerioAPI) {
  const scripts = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).text())
    .get();

  for (const script of scripts) {
    try {
      const payload = JSON.parse(script.trim());
      const date = findDateInJson(payload);
      if (date) {
        return date;
      }
    } catch {
      continue;
    }
  }

  return "";
}

function findDateInJson(value: unknown): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const date = findDateInJson(item);
      if (date) {
        return date;
      }
    }
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  for (const key of ["datePublished", "dateCreated", "dateModified", "uploadDate", "pubDate", "publishDate"]) {
    if (typeof record[key] === "string") {
      const date = normalizeDateString(record[key]);
      if (date) {
        return date;
      }
    }
  }

  for (const nested of Object.values(record)) {
    const date = findDateInJson(nested);
    if (date) {
      return date;
    }
  }

  return "";
}

function extractPageTextDate($: cheerio.CheerioAPI, html: string) {
  const text = cleanText($("body").text() || html).slice(0, 5000);
  const labelPattern = /(?:\u53d1\u5e03\u65f6\u95f4|\u53d1\u5e03\u65e5\u671f|\u53d1\u8868\u65f6\u95f4|\u66f4\u65b0\u65f6\u95f4|\u65f6\u95f4|\u6765\u6e90).{0,30}?((?:20\d{2})(?:[-/.]|\u5e74)(?:[01]?\d)(?:[-/.]|\u6708)(?:[0-3]?\d)\u65e5?)/;
  const labeled = text.match(labelPattern)?.[1];
  const labeledDate = normalizeDateString(labeled ?? "");
  if (labeledDate) {
    return labeledDate;
  }

  return normalizeDateString(text);
}

function normalizeDateString(value: string) {
  if (!value) {
    return "";
  }

  const full = value.match(/(20\d{2})(?:[-/.]|\u5e74)([01]?\d)(?:[-/.]|\u6708)([0-3]?\d)\u65e5?/);
  if (full) {
    return normalizeDateParts(full[1], full[2], full[3]);
  }

  const compact = value.match(/(20\d{2})([01]\d)([0-3]\d)/);
  if (compact) {
    return normalizeDateParts(compact[1], compact[2], compact[3]);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(parsed);
  }

  return "";
}

function normalizeDateParts(year: string, month: string, day: string) {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) {
    return "";
  }
  const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
  return Number.isNaN(Date.parse(date)) ? "" : date;
}
