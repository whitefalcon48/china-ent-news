import { convertDisplayText } from "../displayKanji.js";

export type ArticleTagInput = {
  tags: string[];
  sourceNames: string[];
};

export type ArticleTagCatalog = {
  counts: ReadonlyMap<string, number>;
  minimumArticleCount: number;
};

const MINIMUM_ARTICLE_COUNT = 2;
const MAX_TAGS_PER_ARTICLE = 4;

// Category is already displayed separately. These labels are too broad to
// narrow an archive search, even when they occur often.
const BROAD_TAGS = new Set([
  "映画",
  "中国映画",
  "ドラマ",
  "中国ドラマ",
  "エンタメ",
  "中国エンタメ",
  "俳優",
  "中国俳優",
  "イベント",
  "応援",
  "ニュース"
]);

const LOCATION_ONLY_TAGS = new Set(["北京", "台湾", "広西", "安徽", "大別山"]);
const SOURCE_NAME_EXCEPTIONS = new Set(["国家広播電視総局"]);

const TAG_ALIASES = new Map<string, string[]>([
  ["微短劇", ["ショートドラマ"]],
  ["短劇", ["ショートドラマ"]],
  ["中国短劇", ["ショートドラマ"]],
  ["紅色微短劇", ["ショートドラマ"]],
  ["AI短劇", ["ショートドラマ", "AI"]],
  ["暑期档", ["夏休み興行"]],
  ["夏休み", ["夏休み興行"]],
  ["夏休み映画", ["夏休み興行"]],
  ["夏休みシーズン", ["夏休み興行"]],
  ["興行", ["興行収入"]],
  ["偷票房", ["興行不正"]],
  ["興行収入横取り", ["興行不正"]],
  ["広電総局", ["国家広播電視総局"]],
  ["国家広播電視総局", ["国家広播電視総局"]]
]);

export function buildArticleTagCatalog(inputs: ArticleTagInput[], minimumArticleCount = MINIMUM_ARTICLE_COUNT): ArticleTagCatalog {
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const tags = new Set(normalizeArticleTags(input));
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return { counts, minimumArticleCount };
}

export function getSearchableArticleTags(input: ArticleTagInput, catalog: ArticleTagCatalog) {
  return normalizeArticleTags(input)
    .filter((tag) => (catalog.counts.get(tag) ?? 0) >= catalog.minimumArticleCount)
    .sort((left, right) => (catalog.counts.get(right) ?? 0) - (catalog.counts.get(left) ?? 0) || left.localeCompare(right, "ja"))
    .slice(0, MAX_TAGS_PER_ARTICLE);
}

export function normalizeArticleTags(input: ArticleTagInput) {
  const sourceKeys = new Set(input.sourceNames.flatMap(sourceNameKeys));
  const normalized: string[] = [];
  for (const rawTag of input.tags) {
    const tag = normalizeText(rawTag);
    if (!tag || tag.length > 24 || /https?:|www\.|\.(?:com|cn|net|org)\b/iu.test(tag)) continue;
    if (BROAD_TAGS.has(tag) || LOCATION_ONLY_TAGS.has(tag)) continue;
    if (sourceKeys.has(sourceNameKey(tag)) && !SOURCE_NAME_EXCEPTIONS.has(tag)) continue;
    normalized.push(...(TAG_ALIASES.get(tag) ?? [tag]));
  }
  return [...new Set(normalized)];
}

function normalizeText(value: string) {
  return convertDisplayText(value.normalize("NFKC").trim()).replace(/\s+/gu, " ");
}

function sourceNameKeys(value: string) {
  const normalized = normalizeText(value);
  return [sourceNameKey(normalized), sourceNameKey(normalized.replace(/(?:新聞|ニュース|娛樂|エンタメ|影視産業)$/u, ""))].filter(Boolean);
}

function sourceNameKey(value: string) {
  return value.replace(/[\s・·_-]+/gu, "").toLocaleLowerCase("ja");
}
