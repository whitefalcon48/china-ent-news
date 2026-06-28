import fs from "node:fs/promises";
import path from "node:path";
import type {
  ArticleFilterConfig,
  ArticleType,
  ContextValue,
  FeedBadge,
  FeedCategory,
  FreshnessLabel,
  LevelLabel,
  MainEntities,
  RawArticle,
  SnsHeat,
  SourceTypeLabel
} from "./types.js";

const DEFAULT_FILTER_CONFIG: ArticleFilterConfig = {
  excludeArticleTypes: ["column_opinion", "review", "interview", "static_page"],
  columnOpinionKeywords: ["专栏", "评论", "观点", "观察", "深度", "趋势", "为何", "为什么", "如何看", "怎么看", "是否", "产业分析"],
  reviewKeywords: ["影评", "剧评", "观后感", "评分", "口碑解析"],
  interviewKeywords: ["专访", "访谈", "对话", "采访"],
  staticPageKeywords: ["政务平台", "电子政务", "网站地图", "排行榜", "专题页", "首页", "视频列表", "图片", "图库"],
  snsTrendKeywords: ["热搜", "微博", "话题", "上榜", "讨论"],
  gossipRumorKeywords: ["网传", "爆料", "疑似", "传闻", "绯闻", "回应"],
  dataReportKeywords: ["票房", "收视", "指数", "数据", "突破", "亿元", "榜单", "排名"],
  officialAnnouncementKeywords: ["发布", "宣布", "公告", "公示", "通知", "签署", "召开", "启动", "开幕", "闭幕", "入围", "获奖", "定档", "揭晓", "亮相", "首曝", "开播", "上映", "热映", "出任", "齐聚", "悼念", "身亡", "逝世", "观影"]
};

const OFFICIAL_ONLY_KEYWORDS = ["发布", "宣布", "公告", "公示", "通知", "签署", "召开", "启动"];

export async function loadFilterConfig(configPath = "config/filters.json"): Promise<ArticleFilterConfig> {
  try {
    const raw = await fs.readFile(path.resolve(configPath), "utf8");
    return { ...DEFAULT_FILTER_CONFIG, ...(JSON.parse(raw) as Partial<ArticleFilterConfig>) };
  } catch {
    return DEFAULT_FILTER_CONFIG;
  }
}

export function classifyArticle(article: RawArticle, config: ArticleFilterConfig): RawArticle {
  const articleType = detectArticleType(article, config);
  const topicKey = createTopicKey(article.title);
  const feedCategory = getFeedCategory(article, articleType);
  const publishedDate = getPublishedDate(article);
  const eventDate = getEventDate(article, publishedDate);
  const freshnessLabel = getFreshnessLabel(publishedDate || eventDate);
  const sourceType = getSourceType(article, articleType);
  const isLowPriority = isLowPriorityArticle(article);
  const badge = getBadge(article, articleType, sourceType, isLowPriority);
  const japanVisibility = getJapanVisibility(article);
  const japanGap = getJapanGap(article, feedCategory);
  const contextValue = getContextValue(article, feedCategory);
  const snsHeat = getSnsHeat(article, articleType);
  return {
    ...article,
    articleType,
    skipReason: getSkipReason(article, articleType, config),
    topicKey,
    mainEntities: extractEntities(article.title),
    relatedSources: [{ name: article.sourceName, url: article.url }],
    feedCategory,
    isLowPriority,
    badge,
    sourceType,
    publishedDate,
    eventDate,
    freshnessLabel,
    newsworthinessScore: getNewsworthinessScore(article, articleType, feedCategory, sourceType, freshnessLabel, japanGap, contextValue, snsHeat),
    japanVisibility,
    japanGap,
    contextValue,
    snsHeat
  };
}

export function isPublishableType(articleType: ArticleType) {
  return ["news_event", "official_announcement", "data_report", "gossip_rumor", "sns_trend"].includes(articleType);
}

function detectArticleType(article: RawArticle, config: ArticleFilterConfig): ArticleType {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  const url = article.url.toLowerCase();

  if (includesAny(text, config.staticPageKeywords) || /\/(zt|topic|subject|special|index)\b/.test(url)) {
    return "static_page";
  }
  if (includesAny(text, config.interviewKeywords)) {
    return "interview";
  }
  if (includesAny(text, config.reviewKeywords)) {
    return "review";
  }
  if (includesAny(text, config.columnOpinionKeywords)) {
    return "column_opinion";
  }
  if (includesAny(text, config.gossipRumorKeywords)) {
    return "gossip_rumor";
  }
  if (includesAny(text, config.snsTrendKeywords)) {
    return "sns_trend";
  }
  if (includesAny(text, config.dataReportKeywords)) {
    return "data_report";
  }
  if (article.reliability === "A" || includesAny(text, OFFICIAL_ONLY_KEYWORDS)) {
    return "official_announcement";
  }
  if (includesAny(text, config.officialAnnouncementKeywords) || /[开闭]幕|获奖|定档|上映|发布|宣布|入围|签约|启动|举行|播出|揭晓|亮相|首曝|开播|热映|出任|齐聚|悼念|身亡|逝世|观影/.test(text)) {
    return "news_event";
  }

  return "unknown";
}

function getSkipReason(article: RawArticle, articleType: ArticleType, config: ArticleFilterConfig) {
  if (config.excludeArticleTypes.includes(articleType)) {
    return articleType;
  }
  if (articleType === "unknown" && !article.excerpt && article.title.length < 14) {
    return "unknown_thin_article";
  }
  return "";
}

function getFeedCategory(article: RawArticle, articleType: ArticleType): FeedCategory {
  const text = `${article.title} ${article.category} ${article.excerpt ?? ""}`;

  if (isOverseasChinaFilmFestival(text)) {
    return "海外中国映画祭・文化交流";
  }
  if (article.reliability === "A" || articleType === "official_announcement") {
    return "公式発表";
  }
  if (/电视剧|剧集|短剧|网剧|综艺|播出|开播|平台|优酷|腾讯视频|爱奇艺|芒果TV|B站/.test(text)) {
    return "ドラマ・配信";
  }
  if (/演员|艺人|明星|红毯|经纪|出任|悼念|身亡|逝世|回应|热搜/.test(text)) {
    return "芸能・俳優";
  }
  if (/产业|公司|集团|投资|出品|发行|市场|行业|文旅|票房|收视|数据|指数/.test(text)) {
    return "業界動向";
  }
  if (/电影|影片|导演|影院|影节|电影节|电影周|上映|定档|票房/.test(text)) {
    return "映画";
  }

  return "その他";
}

function isLowPriorityArticle(article: RawArticle) {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  return (
    isGenericOverseasChinaFilmFestival(text) ||
    /文化交流|合作协议|签署合作|友好交流|代表团|座谈会|工作部署|推进会/.test(text) ||
    /开幕/.test(text) && /中国电影节/.test(text)
  );
}

function isOverseasChinaFilmFestival(text: string) {
  return /(?:俄罗斯|刚果|希腊|海外|莫斯科|雅典|巴黎|伦敦|东京|首尔|曼谷|新加坡|马来西亚).{0,12}中国电影节|中国电影节.{0,12}(?:俄罗斯|刚果|希腊|海外|莫斯科|雅典|巴黎|伦敦|东京|首尔|曼谷|新加坡|马来西亚)/.test(text);
}

function isGenericOverseasChinaFilmFestival(text: string) {
  return isOverseasChinaFilmFestival(text) && !/片单|展映|上映|获奖|导演|演员|观众|票房|交流周|主竞赛|入围/.test(text);
}

function getPublishedDate(article: RawArticle) {
  if (article.publishedAt) {
    return normalizeDate(article.publishedAt);
  }

  const urlDate = article.url.match(/(20\d{2})[-/]?([01]\d)[-/]?([0-3]\d)/);
  if (urlDate) {
    return `${urlDate[1]}-${urlDate[2]}-${urlDate[3]}`;
  }

  return "";
}

function getEventDate(article: RawArticle, fallbackDate: string) {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  const fullDate = text.match(/(20\d{2})年([01]?\d)月([0-3]?\d)日/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, "0")}-${fullDate[3].padStart(2, "0")}`;
  }

  const monthDay = text.match(/([01]?\d)月([0-3]?\d)日/);
  if (monthDay) {
    const year = fallbackDate.slice(0, 4) || today().slice(0, 4);
    return `${year}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
  }

  return fallbackDate;
}

function normalizeDate(value: string) {
  const date = new Date(value);
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

function getFreshnessLabel(dateValue: string): FreshnessLabel {
  if (!dateValue) {
    return "background";
  }

  const diffDays = Math.floor((Date.parse(today()) - Date.parse(dateValue)) / 86400000);
  if (diffDays <= 0) {
    return "today";
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays <= 7) {
    return "recent";
  }
  if (diffDays <= 30) {
    return "old";
  }
  return "background";
}

function getSourceType(article: RawArticle, articleType: ArticleType): SourceTypeLabel {
  if (articleType === "sns_trend") {
    return "sns";
  }
  if (articleType === "gossip_rumor") {
    return "rumor";
  }
  if (article.reliability === "A" || /国家|总局|电影局|官方|政府/.test(article.sourceName)) {
    return isPrLike(article) ? "pr_like" : "official";
  }
  if (articleType === "data_report") {
    return "data";
  }
  return "media_report";
}

function getBadge(article: RawArticle, articleType: ArticleType, sourceType: SourceTypeLabel, isLowPriority: boolean): FeedBadge {
  if (articleType === "sns_trend") {
    return "HOT SEARCH";
  }
  if (sourceType === "official") {
    return "OFFICIAL";
  }
  if (articleType === "data_report") {
    return "DATA";
  }
  if (sourceType === "pr_like" || isPrLike(article)) {
    return "PR WATCH";
  }
  if (isLowPriority) {
    return "WATCH";
  }
  return "NEWS";
}

function getJapanVisibility(article: RawArticle): LevelLabel {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  if (/日本|日版|日本上映|日本公開|字幕|东京|東京/.test(text)) {
    return "high";
  }
  if (/上海国际电影节|张颂文|百花奖|金爵奖|微博/.test(text)) {
    return "medium";
  }
  if (/地方|方言|女性|豆瓣|短剧|饭圈|流量|控评|番位|CP|营销号|塌房|海外中国电影节|中国电影节/.test(text)) {
    return "low";
  }
  return "unknown";
}

function getJapanGap(article: RawArticle, feedCategory: FeedCategory): LevelLabel {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  if (/豆瓣|方言|地方|女性|饭圈|流量|控评|番位|CP|营销号|塌房|短剧|海外中国电影节|中国电影节/.test(text)) {
    return "high";
  }
  if (feedCategory === "海外中国映画祭・文化交流" || feedCategory === "業界動向") {
    return "medium";
  }
  return "unknown";
}

function getContextValue(article: RawArticle, feedCategory: FeedCategory): ContextValue {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  if (/国家|文化交流|海外|中国电影节|产业|票房|豆瓣|短剧|饭圈|流量|女性|方言|地方|字幕|日本/.test(text)) {
    return "high";
  }
  if (feedCategory === "業界動向" || feedCategory === "海外中国映画祭・文化交流") {
    return "medium";
  }
  return "low";
}

function getSnsHeat(article: RawArticle, articleType: ArticleType): SnsHeat {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  if (articleType === "sns_trend" || /热搜|爆|微博/.test(text)) {
    return "high";
  }
  if (/豆瓣|话题|讨论|粉丝/.test(text)) {
    return "medium";
  }
  return "none";
}

function getNewsworthinessScore(
  article: RawArticle,
  articleType: ArticleType,
  feedCategory: FeedCategory,
  sourceType: SourceTypeLabel,
  freshnessLabel: FreshnessLabel,
  japanGap: LevelLabel,
  contextValue: ContextValue,
  snsHeat: SnsHeat
) {
  let score = 50;
  if (freshnessLabel === "today") score += 18;
  if (freshnessLabel === "yesterday") score += 14;
  if (freshnessLabel === "recent") score += 8;
  if (freshnessLabel === "old") score -= 10;
  if (freshnessLabel === "background") score -= 15;
  if (articleType === "data_report") score += 12;
  if (articleType === "sns_trend") score += 12;
  if (articleType === "official_announcement") score += 4;
  if (sourceType === "pr_like") score -= 8;
  if (sourceType === "rumor") score -= 10;
  if (japanGap === "high") score += 14;
  if (japanGap === "medium") score += 8;
  if (contextValue === "high") score += 12;
  if (contextValue === "medium") score += 6;
  if (snsHeat === "high") score += 10;
  if (snsHeat === "medium") score += 5;
  if (feedCategory === "海外中国映画祭・文化交流" && !isGenericOverseasChinaFilmFestival(`${article.title} ${article.excerpt ?? ""}`)) score += 6;
  if (article.isLowPriority) score -= 12;
  return Math.max(0, Math.min(100, score));
}

function isPrLike(article: RawArticle) {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  return /文化交流|合作协议|签署合作|代表团|致辞|会见|工作部署|推进会|座谈会/.test(text);
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function createTopicKey(title: string) {
  if (/上海国际电影节|上影节|金爵奖/.test(title)) {
    return "上海国际电影节";
  }
  if (/给阿嬷的情书/.test(title)) {
    return "给阿嬷的情书";
  }
  if (/百花奖|大众电影百花奖/.test(title)) {
    return "大众电影百花奖";
  }

  const work = title.match(/《([^》]+)》/)?.[1];
  if (work) {
    return cleanTopicKey(work);
  }

  const quoted = title.match(/[“「『]([^”」』]+)[”」』]/)?.[1];
  if (quoted) {
    return cleanTopicKey(quoted);
  }

  const festival = title.match(/第?\d*届?[^，。！!？?、\s]*(?:电影节|电影周|电影展|传媒关注单元|金爵奖|百花奖)/)?.[0];
  if (festival) {
    return cleanTopicKey(festival);
  }

  return cleanTopicKey(title.split(/[，。！!？?：:、|]/)[0] ?? title);
}

function cleanTopicKey(value: string) {
  return value.replace(/\s+/g, "").slice(0, 30) || "unknown";
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function extractEntities(title: string): MainEntities {
  return {
    people: [],
    works: [...title.matchAll(/《([^》]+)》/g)].map((match) => match[1]).filter(Boolean),
    organizations: [...title.matchAll(/([\p{Script=Han}A-Za-z0-9]{2,20}(?:电影节|电影周|电影展|电影局|总局|集团|基金|传媒关注单元))/gu)].map((match) => match[1])
  };
}
