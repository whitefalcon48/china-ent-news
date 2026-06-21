import fs from "node:fs/promises";
import path from "node:path";
import type { ArticleFilterConfig, ArticleType, MainEntities, RawArticle } from "./types.js";

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
  return {
    ...article,
    articleType,
    skipReason: getSkipReason(article, articleType, config),
    topicKey,
    mainEntities: extractEntities(article.title),
    relatedSources: [article.sourceName]
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

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function createTopicKey(title: string) {
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

function extractEntities(title: string): MainEntities {
  return {
    people: [],
    works: [...title.matchAll(/《([^》]+)》/g)].map((match) => match[1]).filter(Boolean),
    organizations: [...title.matchAll(/([\p{Script=Han}A-Za-z0-9]{2,20}(?:电影节|电影周|电影展|电影局|总局|集团|基金|传媒关注单元))/gu)].map((match) => match[1])
  };
}
