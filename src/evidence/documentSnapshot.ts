import * as cheerio from "cheerio";

export type DocumentSnapshot = {
  title: string;
  text: string;
  published_date: string;
};

/** Pure HTML extraction used after a discovery URL has been fetched. */
export function extractDocumentSnapshot(html: string, fallbackTitle = ""): DocumentSnapshot {
  const $ = cheerio.load(html);
  const title = clean($("meta[property='og:title']").attr("content") || $("title").text() || fallbackTitle);
  const publishedDate = extractPublishedDate($, html);
  const preferred = $("article").text() || $("main").text() || $(".article-content").text() || $(".content").text() || $("body").text();
  return { title, text: clean(preferred).slice(0, 12000), published_date: publishedDate };
}

function extractPublishedDate($: cheerio.CheerioAPI, html: string) {
  const values = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='publishdate']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("meta[name='date']").attr("content"),
    $("time").first().attr("datetime"),
    $("time").first().text(),
    html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1]
  ];
  for (const value of values) {
    const normalized = toIsoDate(value ?? "");
    if (normalized) return normalized;
  }
  return toIsoDate(html);
}

function toIsoDate(value: string) {
  const matched = value.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/);
  if (!matched) return "";
  const [, year, month, day] = matched;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
