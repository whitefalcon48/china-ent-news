import { resolveSummaryTitle } from "../summaryTitle.js";
import type { ProcessedArticle } from "../types.js";

// X の字数仕様: 上限280。U+0000–U+10FF などの狭い文字=1、CJK・絵文字=2、URLは t.co 換算で一律23
export const MAX_WEIGHTED_LENGTH = 280;
const URL_WEIGHT = 23;
const URL_PATTERN = /https?:\/\/\S+/g;
const NARROW_RANGES: Array<[number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037]
];

export function xWeightedLength(text: string) {
  let total = 0;
  for (const segment of text.split(URL_PATTERN)) total += weightWithoutUrls(segment);
  const urls = text.match(URL_PATTERN);
  return total + (urls?.length ?? 0) * URL_WEIGHT;
}

function weightWithoutUrls(text: string) {
  let total = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    total += NARROW_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end) ? 1 : 2;
  }
  return total;
}

export function truncateToWeight(value: string, maxWeight: number) {
  if (xWeightedLength(value) <= maxWeight) return value;
  const ellipsisWeight = weightWithoutUrls("…");
  const characters: string[] = [];
  let total = 0;
  for (const character of value) {
    const weight = weightWithoutUrls(character);
    if (total + weight > maxWeight - ellipsisWeight) break;
    characters.push(character);
    total += weight;
  }
  return `${characters.join("")}…`;
}

export function buildBingtangHook(value: string | undefined, maxWeight: number) {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (!normalized) return "";
  const sentence = normalized.match(/^[\s\S]*?[。！？!?](?:[」』”"])?/u)?.[0] ?? normalized;
  const prefix = "ビンタン「";
  const suffix = "」";
  const contentWeight = maxWeight - xWeightedLength(prefix) - xWeightedLength(suffix);
  if (contentWeight < 8) return "";
  return `${prefix}${truncateToWeight(sentence, contentWeight)}${suffix}`;
}

export function buildDailyDigest(dateValue: string, articles: ProcessedArticle[], siteUrl: string, basePath = "") {
  const [, month, day] = dateValue.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) throw new Error(`X投稿日が不正です: ${dateValue}`);
  const normalizedSiteUrl = siteUrl.replace(/\/$/u, "");
  const normalizedBasePath = basePath && basePath !== "/" ? `/${basePath.replace(/^\/+|\/+$/gu, "")}` : "";
  const header = `🧊 今日の中国エンタメ｜${Number(month)}/${Number(day)}`;
  const url = `${normalizedSiteUrl}${normalizedBasePath}/archive/${dateValue}/`;
  const footer = `ほか全${articles.length}本👇\n${url}`;
  const hook = buildBingtangHook(articles[0]?.summary?.why_it_matters, 76);
  const fixedLength = xWeightedLength(`${header}\n${hook ? `${hook}\n` : ""}\n${footer}`);
  if (fixedLength >= MAX_WEIGHTED_LENGTH) throw new Error("SITE_URLが長すぎてXダイジェストを組み立てられません");
  const candidates = articles.slice(0, 3).map((article) => {
    if (!article.summary) return "";
    return resolveSummaryTitle(article.summary.title_ja, article.raw.title);
  }).filter(Boolean);
  const lines: string[] = [];
  let remaining = MAX_WEIGHTED_LENGTH - fixedLength;
  for (let index = 0; index < candidates.length; index++) {
    const remainingItems = candidates.length - index;
    const allowance = Math.max(20, Math.floor((remaining - remainingItems * 3) / remainingItems));
    const line = `・${truncateToWeight(candidates[index], allowance - 2)}`;
    const cost = xWeightedLength(line) + 1;
    if (cost > remaining) break;
    lines.push(line);
    remaining -= cost;
  }
  for (let index = 0; index < lines.length && remaining > 0; index++) {
    const full = `・${candidates[index]}`;
    if (lines[index] === full) continue;
    const currentCost = xWeightedLength(lines[index]);
    const expanded = xWeightedLength(full) - currentCost <= remaining ? full : `・${truncateToWeight(candidates[index], currentCost - 2 + remaining)}`;
    remaining -= xWeightedLength(expanded) - currentCost;
    lines[index] = expanded;
  }
  return `${header}\n${hook ? `${hook}\n` : ""}${lines.join("\n")}\n${footer}`;
}

export interface IndividualPost {
  priority: string;
  category: string;
  title: string;
  text: string;
  weightedLength: number;
}

// 個別投稿はテキストのみ・URLなし・ハッシュタグなし。
// 根拠確認済みの why_it_matters から先頭の一文を再利用し、新しい事実や感想は生成しない。
export function buildIndividualPosts(articles: ProcessedArticle[]): IndividualPost[] {
  const posts: IndividualPost[] = [];
  for (const article of articles) {
    const summary = article.summary;
    if (!summary) continue;
    const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
    if (!title) continue;
    const category = summary.category?.trim() || article.raw.category?.trim() || "その他";
    const titleLine = truncateToWeight(`【${category}】${title}`, 156);
    const hook = buildBingtangHook(summary.why_it_matters, MAX_WEIGHTED_LENGTH - xWeightedLength(titleLine) - 1);
    const fallback = truncateToWeight(summary.lead?.trim() ?? "", MAX_WEIGHTED_LENGTH - xWeightedLength(titleLine) - 1);
    const text = hook || fallback ? `${titleLine}\n${hook || fallback}` : titleLine;
    posts.push({
      priority: summary.publish_priority ?? "medium",
      category,
      title,
      text,
      weightedLength: xWeightedLength(text)
    });
  }
  return posts;
}

export function buildPostsMarkdown(dateValue: string, digest: string, posts: IndividualPost[]) {
  const lines: string[] = [];
  lines.push(`# X投稿文面 ${dateValue}`);
  lines.push("");
  lines.push("## 日次ダイジェスト（URL付き・1日1本）");
  lines.push("");
  lines.push(`字数: ${xWeightedLength(digest)}/${MAX_WEIGHTED_LENGTH}（X換算・CJK=2）`);
  lines.push("");
  lines.push("```");
  lines.push(digest);
  lines.push("```");
  lines.push("");
  lines.push("## 個別投稿候補（ビンタンのひとこと入り・URLなし）");
  lines.push("");
  lines.push("予約するものを選んでコピーしてください。誘導はプロフィール固定リンクで行います。");
  posts.forEach((post, index) => {
    lines.push("");
    lines.push(`### ${index + 1}. [${post.priority}／${post.category}] ${post.title}`);
    lines.push("");
    lines.push(`字数: ${post.weightedLength}/${MAX_WEIGHTED_LENGTH}`);
    lines.push("");
    lines.push("```");
    lines.push(post.text);
    lines.push("```");
  });
  lines.push("");
  return lines.join("\n");
}
