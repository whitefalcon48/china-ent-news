import Parser from "rss-parser";

export type HotSearchAuditItem = {
  title: string;
  url: string;
  description: string;
  rank?: number;
  hot_value?: string;
  category?: string;
  entertainment_match_reason: string;
};

export type HotSearchAuditResult = {
  source_name: string;
  route: string;
  fetch_status: "success" | "failed" | "empty" | "not_configured";
  fetch_error: string;
  raw_count: number;
  entertainment_like_count: number;
  sample_items: HotSearchAuditItem[];
};

const DEFAULT_RSSHUB_BASE_URL = "https://rsshub.app";
const DEFAULT_HOT_SEARCH_ROUTES = ["/weibo/search/hot"];
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_SAMPLE_ITEMS = 20;

const ENTERTAINMENT_KEYWORDS = [
  "电影",
  "电视剧",
  "剧集",
  "综艺",
  "演员",
  "导演",
  "票房",
  "豆瓣",
  "播出",
  "开播",
  "上映",
  "定档",
  "预告",
  "明星",
  "角色",
  "CP",
  "番位",
  "粉丝",
  "热搜",
  "塌房",
  "官宣"
];

type RssItem = {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  categories?: string[];
};

export async function auditHotSearchSources(): Promise<HotSearchAuditResult[]> {
  if (process.env.WEIBO_HOT_SEARCH_ENABLED === "false") {
    return [
      {
        source_name: "Weibo HOT SEARCH",
        route: "",
        fetch_status: "not_configured",
        fetch_error: "",
        raw_count: 0,
        entertainment_like_count: 0,
        sample_items: []
      }
    ];
  }

  const baseUrl = process.env.RSSHUB_BASE_URL ?? DEFAULT_RSSHUB_BASE_URL;
  const routes = parseRoutes(process.env.WEIBO_HOT_SEARCH_ROUTES ?? process.env.WEIBO_HOT_SEARCH_PATH);
  return Promise.all(routes.map((route) => auditHotSearchRoute(baseUrl, route)));
}

function parseRoutes(value?: string) {
  if (!value?.trim()) {
    return DEFAULT_HOT_SEARCH_ROUTES;
  }
  return value
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
    .map((route) => (route.startsWith("/") ? route : `/${route}`));
}

async function auditHotSearchRoute(baseUrl: string, route: string): Promise<HotSearchAuditResult> {
  const sourceName = `Weibo HOT SEARCH ${route}`;
  const url = new URL(route, ensureTrailingSlash(baseUrl)).toString();
  try {
    const xml = await fetchText(url);
    const parser = new Parser();
    const feed = await parser.parseString(xml);
    const items = (feed.items ?? []) as RssItem[];
    const sampleItems = items.slice(0, MAX_SAMPLE_ITEMS).map(toHotSearchItem);
    return {
      source_name: sourceName,
      route,
      fetch_status: items.length ? "success" : "empty",
      fetch_error: "",
      raw_count: items.length,
      entertainment_like_count: sampleItems.filter((item) => item.entertainment_match_reason).length,
      sample_items: sampleItems
    };
  } catch (error) {
    return {
      source_name: sourceName,
      route,
      fetch_status: "failed",
      fetch_error: describeFetchError(error),
      raw_count: 0,
      entertainment_like_count: 0,
      sample_items: []
    };
  }
}

async function fetchText(url: string) {
  const timeoutMs = Number(process.env.WEIBO_HOT_SEARCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase0/0.1)"
    },
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function toHotSearchItem(item: RssItem, index: number): HotSearchAuditItem {
  const title = cleanText(item.title ?? "");
  const description = cleanText(item.contentSnippet ?? item.summary ?? stripHtml(item.content ?? ""));
  const category = item.categories?.filter(Boolean).join(", ") ?? "";
  const matchReason = getEntertainmentMatchReason(`${title} ${description} ${category}`);
  return {
    title,
    url: item.link ?? "",
    description,
    rank: index + 1,
    hot_value: extractHotValue(description),
    category,
    entertainment_match_reason: matchReason
  };
}

function getEntertainmentMatchReason(text: string) {
  const matches = ENTERTAINMENT_KEYWORDS.filter((keyword) => text.includes(keyword));
  return matches.length ? `keyword:${matches.slice(0, 5).join(",")}` : "";
}

function extractHotValue(description: string) {
  const explicit = description.match(/(?:热度|阅读|讨论|搜索|指数|hot)[：:\s]*([0-9][0-9.,万亿wWkK]*)/i);
  if (explicit) {
    return explicit[1];
  }
  const loose = description.match(/([0-9][0-9.,]*(?:万|亿|w|W|k|K)?)/);
  return loose?.[1] ?? "";
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function describeFetchError(error: unknown) {
  if (error instanceof Error) {
    const cause = "cause" in error && error.cause instanceof Error ? ` cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}
