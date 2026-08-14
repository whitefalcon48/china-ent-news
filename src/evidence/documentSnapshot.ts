import * as cheerio from "cheerio";

export type DocumentSnapshot = {
  title: string;
  text: string;
  published_date: string;
  extraction_method: DocumentExtractionMethod;
  extraction_quality: DocumentExtractionQuality;
};

export type DocumentExtractionQuality = {
  status: "usable" | "limited" | "unusable";
  raw_chars: number;
  meaningful_chars: number;
  sentence_count: number;
  boilerplate_ratio: number;
  factual_anchor_count: number;
};

export type DocumentExtractionMethod =
  | "article_selector"
  | "embedded_article"
  | "json_ld"
  | "main_selector"
  | "meta_description"
  | "generic_content"
  | "body_fallback"
  | "none";

type TextCandidate = { text: string; method: DocumentExtractionMethod; priority: number; quality: DocumentExtractionQuality };

const BOILERPLATE = /(?:加载更多|正在阅读|正在加载|分享|扫一扫|分享到微信|手机看|手机继续看|点击收起全文|返回[^\s]{0,8}(?:首页|频道)|责任编辑|登录|注册|A-\s*A\+)/gu;
const EMBEDDED_HTML_MARKER = /\[!--begin:[^\]]+--\][\s\S]*?\[!--end:[^\]]+--\]/giu;

/** Pure HTML extraction used after a discovery URL has been fetched. */
export function extractDocumentSnapshot(html: string, fallbackTitle = ""): DocumentSnapshot {
  const $ = cheerio.load(html);
  const title = clean($("meta[property='og:title']").attr("content") || $("title").text() || fallbackTitle);
  const publishedDate = extractPublishedDate($, html);
  const candidates: TextCandidate[] = [];
  addSelectorCandidates($, candidates, "article, [itemprop='articleBody'], .article-content, .article_content, .article-body, .article_body, #article-content, #article_content", "article_selector", 800);
  for (const text of extractEmbeddedArticleTexts(html)) addCandidate(candidates, text, "embedded_article", 740);
  for (const text of extractJsonLdTexts($)) addCandidate(candidates, text, "json_ld", 760);
  addSelectorCandidates($, candidates, "main", "main_selector", 600);
  addCandidate(candidates, $("meta[property='og:description']").attr("content") || $("meta[name='description']").attr("content") || "", "meta_description", 780);
  addSelectorCandidates($, candidates, ".content_area, #content_area, .content", "generic_content", 500);

  const body = $("body").clone();
  body.find("script, style, noscript, nav, header, footer, form, aside").remove();
  addCandidate(candidates, body.text(), "body_fallback", -4000);

  const selected = candidates.sort((left, right) => candidateScore(right) - candidateScore(left))[0];
  return {
    title,
    text: (selected?.text ?? "").slice(0, 12000),
    published_date: publishedDate,
    extraction_method: selected?.method ?? "none",
    extraction_quality: selected?.quality ?? emptyQuality()
  };
}

function addSelectorCandidates(
  $: cheerio.CheerioAPI,
  candidates: TextCandidate[],
  selector: string,
  method: DocumentExtractionMethod,
  priority: number
) {
  $(selector).each((_index, element) => addCandidate(candidates, $(element).text(), method, priority));
}

function addCandidate(candidates: TextCandidate[], value: string, method: DocumentExtractionMethod, priority: number) {
  const raw = clean(value.replace(EMBEDDED_HTML_MARKER, " "));
  const text = cleanArticleText(value);
  if (!raw && !text) return;
  candidates.push({ text, method, priority, quality: assessExtractionQuality(raw, text) });
}

function candidateScore(candidate: TextCandidate) {
  const qualityWeight = candidate.quality.status === "usable" ? 10_000 : candidate.quality.status === "limited" ? 5_000 : 0;
  return qualityWeight + candidate.priority + Math.min(candidate.text.length, 3000) + candidate.quality.sentence_count * 30 + candidate.quality.factual_anchor_count * 20;
}

export function assessExtractionQuality(raw: string, meaningful = cleanArticleText(raw)): DocumentExtractionQuality {
  const rawChars = raw.length;
  const meaningfulChars = meaningful.length;
  const sentenceCount = (meaningful.match(/[。！？!?]/gu) ?? []).length;
  const factualAnchorCount = countFactualAnchors(meaningful);
  const boilerplateRatio = rawChars ? Math.max(0, Math.min(1, (rawChars - meaningfulChars) / rawChars)) : 1;
  const status = meaningfulChars >= 120 && sentenceCount >= 2 && boilerplateRatio <= 0.35
    ? "usable"
    : meaningfulChars >= 40 && sentenceCount >= 1 && boilerplateRatio <= 0.5 && (factualAnchorCount >= 2 || sentenceCount >= 2)
      ? "limited"
      : "unusable";
  return {
    status,
    raw_chars: rawChars,
    meaningful_chars: meaningfulChars,
    sentence_count: sentenceCount,
    boilerplate_ratio: Number(boilerplateRatio.toFixed(3)),
    factual_anchor_count: factualAnchorCount
  };
}

function countFactualAnchors(value: string) {
  const numeric = value.match(/(?:\d+(?:[.,]\d+)?|[一二三四五六七八九十百千万]+)(?:亿元|万元|元|亿|万|部|天|日|年|%|％)/gu) ?? [];
  const dated = value.match(/(?:截至|目前|当日|昨日|今年|去年|本届|暑期档|春节档)/gu) ?? [];
  return new Set([...numeric, ...dated]).size;
}

function emptyQuality(): DocumentExtractionQuality {
  return { status: "unusable", raw_chars: 0, meaningful_chars: 0, sentence_count: 0, boilerplate_ratio: 1, factual_anchor_count: 0 };
}

function cleanArticleText(value: string) {
  return clean(value.replace(EMBEDDED_HTML_MARKER, " ").replace(BOILERPLATE, " "));
}

function extractEmbeddedArticleTexts(html: string) {
  const values: string[] = [];
  const patterns = [
    /(?:var\s+)?contentdate\s*=\s*'((?:\\.|[^'])*)'/giu,
    /(?:var\s+)?contentdate\s*=\s*"((?:\\.|[^"])*)"/giu
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const decoded = decodeJavascriptString(match[1] ?? "");
      const fragment = cheerio.load(decoded);
      values.push(fragment.root().text());
    }
  }
  return values;
}

function decodeJavascriptString(value: string) {
  return value
    .replace(/\\u([0-9a-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\n|\\r|\\t/gu, " ")
    .replace(/\\([\\'"/])/gu, "$1");
}

function extractJsonLdTexts($: cheerio.CheerioAPI) {
  const values: string[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      collectJsonLdText(JSON.parse($(element).text()), values);
    } catch {
      // Invalid optional metadata must not make source collection fail.
    }
  });
  return values;
}

function collectJsonLdText(value: unknown, values: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdText(item, values);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const key of ["articleBody", "description"]) {
    if (typeof object[key] === "string") values.push(object[key]);
  }
  if (object["@graph"]) collectJsonLdText(object["@graph"], values);
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
