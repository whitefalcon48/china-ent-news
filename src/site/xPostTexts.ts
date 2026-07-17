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

export interface IndividualPost {
  priority: string;
  category: string;
  title: string;
  text: string;
  weightedLength: number;
}

// 設計正本（design-phase4-site.html §3）: 個別投稿はテキストのみ・URLなし・ハッシュタグなし・
// 見出しとリードの機械組み立てのみ（新規生成しない）
export function buildIndividualPosts(articles: ProcessedArticle[]): IndividualPost[] {
  const posts: IndividualPost[] = [];
  for (const article of articles) {
    const summary = article.summary;
    if (!summary) continue;
    const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
    if (!title) continue;
    const category = summary.category?.trim() || article.raw.category?.trim() || "その他";
    const joiner = /[。！？!?]$/.test(title) ? "" : "。";
    const text = truncateToWeight(`【${category}】${title}${joiner}${summary.lead?.trim() ?? ""}`, MAX_WEIGHTED_LENGTH);
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
  lines.push("## 個別投稿候補（テキストのみ・URLなし）");
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
