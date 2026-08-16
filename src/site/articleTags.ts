import { convertDisplayText } from "../displayKanji.js";

export type ArticleTagEntities = {
  people: string[];
  works: string[];
  organizations: string[];
  events?: string[];
};

export type ArticleTagInput = {
  tags: string[];
  sourceNames: string[];
  titles: string[];
  mainEntities: ArticleTagEntities;
};

export type ArticleTagCatalog = {
  /** Counts for the final, searchable tag set, including singleton central entities. */
  counts: ReadonlyMap<string, number>;
  /** Counts before the cross-article threshold is applied to free-form themes. */
  themeCounts: ReadonlyMap<string, number>;
  minimumThemeArticleCount: number;
  sourceKeys: ReadonlySet<string>;
};

const MINIMUM_THEME_ARTICLE_COUNT = 2;
const MAX_TAGS_PER_ARTICLE = 4;
const MAX_ENTITY_TAGS_PER_ARTICLE = 3;

// Category is already displayed separately. These labels are too broad to
// narrow an archive search, even when they occur often.
const BROAD_TAGS = normalizedSet([
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

const LOCATION_ONLY_TAGS = normalizedSet([
  "中国",
  "日本",
  "北京",
  "台湾",
  "広西",
  "安徽",
  "大別山",
  "深圳",
  "桃園"
]);

// These are summaries, promotional labels, or one-off details that do not
// define a useful recurring archive view.
const LOW_VALUE_THEME_TAGS = normalizedSet([
  "ASEAN",
  "宇宙",
  "高品質ドラマ",
  "大女主",
  "精品化",
  "がん闘病",
  "文旅融合",
  "名前間違い",
  "ストップ高",
  "株価",
  "公示",
  "補助金"
]);

const PLATFORM_OR_OBSERVATION_TAGS = normalizedSet([
  "微博",
  "微博熱捜",
  "微博热搜",
  "微博トレンド",
  "熱捜",
  "热搜",
  "SNS",
  "ソーシャルメディア",
  "1905电影网",
  "1905電影網"
]);

const RAW_TAG_ALIASES: Array<[string[], string[]]> = [
  [["微短劇", "微短剧", "短劇", "短剧", "中国短劇", "中国短剧", "紅色微短劇", "红色微短剧"], ["ショートドラマ"]],
  [["AI短劇", "AI短剧"], ["ショートドラマ", "AI"]],
  [["暑期档", "暑期檔", "夏休み", "夏休み映画", "夏休みシーズン"], ["夏休み興行"]],
  [["興行", "票房"], ["興行収入"]],
  [["偷票房", "興行収入横取り"], ["興行不正"]],
  [["広電総局", "广电总局", "国家广播电视总局", "国家広播電視総局"], ["国家広播電視総局"]],
  [[
    "龙餐馆",
    "龍餐館",
    "龍餐馆",
    "竜餐館",
    "欢迎来龙餐馆",
    "歡迎來龍餐館",
    "歓迎来龍餐館",
    "歓迎来龍餐馆",
    "歓迎来竜餐館"
  ], ["龍餐館"]]
];

const TAG_ALIASES = buildAliasMap(RAW_TAG_ALIASES);
const ALIAS_KEYS_BY_CANONICAL = buildAliasKeysByCanonical(RAW_TAG_ALIASES);

type EntityType = "work" | "person" | "event" | "organization";
type EntityCandidate = {
  tag: string;
  type: EntityType;
  index: number;
  titleMentioned: boolean;
  rawTagMentioned: boolean;
};

export function buildArticleTagCatalog(
  inputs: ArticleTagInput[],
  minimumThemeArticleCount = MINIMUM_THEME_ARTICLE_COUNT
): ArticleTagCatalog {
  const sourceKeys = new Set(inputs.flatMap((input) => input.sourceNames.flatMap(sourceNameKeys)));
  const entityTagsByArticle = inputs.map((input) => normalizeEntityTags(input));
  const themeTagsByArticle = inputs.map((input) => normalizeThemeTags(input, sourceKeys));
  const themeCounts = countTagsByArticle(themeTagsByArticle);
  const counts = new Map<string, number>();

  inputs.forEach((_, index) => {
    const finalTags = combineTags(
      entityTagsByArticle[index],
      themeTagsByArticle[index].filter((tag) => (themeCounts.get(tag) ?? 0) >= minimumThemeArticleCount),
      themeCounts
    );
    for (const tag of new Set(finalTags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  });

  return { counts, themeCounts, minimumThemeArticleCount, sourceKeys };
}

export function getSearchableArticleTags(input: ArticleTagInput, catalog: ArticleTagCatalog) {
  const entityTags = normalizeEntityTags(input);
  const themeTags = normalizeThemeTags(input, catalog.sourceKeys)
    .filter((tag) => (catalog.themeCounts.get(tag) ?? 0) >= catalog.minimumThemeArticleCount);
  return combineTags(entityTags, themeTags, catalog.themeCounts);
}

/**
 * Returns normalized candidates before the theme frequency gate. This is used
 * by diagnostics and keeps the entity/theme boundary visible to callers.
 */
export function normalizeArticleTags(input: ArticleTagInput) {
  return {
    entities: normalizeEntityTags(input),
    themes: normalizeThemeTags(input, new Set(input.sourceNames.flatMap(sourceNameKeys)))
  };
}

function normalizeEntityTags(input: ArticleTagInput) {
  const normalizedRawTags = new Set(input.tags.flatMap(normalizeTagAliases));
  const sourceKeys = new Set(input.sourceNames.flatMap(sourceNameKeys));
  const candidates: EntityCandidate[] = [];
  const addCandidates = (values: string[], type: EntityType) => {
    values.forEach((value, index) => {
      const tag = normalizeEntityName(value);
      if (!isUsableTag(tag) || isBroadOrLocation(tag) || isPlatformOrObservation(tag)) return;
      if (type === "organization" && sourceKeys.has(sourceNameKey(tag)) && tag !== "国家広播電視総局") return;
      const titleMentioned = isEntityMentioned(value, tag, input.titles);
      const rawTagMentioned = normalizedRawTags.has(tag);
      // main_entities can contain an entire cast or every evidence provider.
      // Treat the title and the LLM's explicit raw-tag choice as centrality
      // evidence instead of publishing all extracted names.
      if (!titleMentioned && !rawTagMentioned) return;
      candidates.push({ tag, type, index, titleMentioned, rawTagMentioned });
    });
  };

  addCandidates(input.mainEntities.works ?? [], "work");
  addCandidates(input.mainEntities.people ?? [], "person");
  addCandidates(input.mainEntities.events ?? [], "event");
  addCandidates(input.mainEntities.organizations ?? [], "organization");

  const unique = new Map<string, EntityCandidate>();
  for (const candidate of candidates) {
    const current = unique.get(candidate.tag);
    if (!current || compareEntityCandidates(candidate, current) < 0) unique.set(candidate.tag, candidate);
  }
  return [...unique.values()]
    .sort(compareEntityCandidates)
    .slice(0, MAX_ENTITY_TAGS_PER_ARTICLE)
    .map((candidate) => candidate.tag);
}

function normalizeThemeTags(input: ArticleTagInput, sourceKeys: ReadonlySet<string>) {
  const entityTags = new Set([
    ...(input.mainEntities.people ?? []),
    ...(input.mainEntities.works ?? []),
    ...(input.mainEntities.events ?? []),
    ...(input.mainEntities.organizations ?? [])
  ].map(normalizeEntityName));
  const normalized: string[] = [];
  for (const rawTag of input.tags) {
    for (const tag of normalizeTagAliases(rawTag)) {
      if (!isUsableTag(tag) || isBroadOrLocation(tag) || LOW_VALUE_THEME_TAGS.has(tag)) continue;
      if (isPlatformOrObservation(tag) || sourceKeys.has(sourceNameKey(tag))) continue;
      // Person/work/event/organization names are owned by the entity layer and
      // must not gain or lose searchability through theme frequency.
      if (entityTags.has(tag)) continue;
      normalized.push(tag);
    }
  }
  return [...new Set(normalized)];
}

function combineTags(entityTags: string[], themeTags: string[], themeCounts: ReadonlyMap<string, number>) {
  const sortedThemes = [...new Set(themeTags)]
    .filter((tag) => !entityTags.includes(tag))
    .sort((left, right) => (themeCounts.get(right) ?? 0) - (themeCounts.get(left) ?? 0) || left.localeCompare(right, "ja"));
  return [...entityTags, ...sortedThemes].slice(0, MAX_TAGS_PER_ARTICLE);
}

function compareEntityCandidates(left: EntityCandidate, right: EntityCandidate) {
  if (left.titleMentioned !== right.titleMentioned) return left.titleMentioned ? -1 : 1;
  if (left.rawTagMentioned !== right.rawTagMentioned) return left.rawTagMentioned ? -1 : 1;
  const leftPrimary = left.index === 0;
  const rightPrimary = right.index === 0;
  if (leftPrimary !== rightPrimary) return leftPrimary ? -1 : 1;
  const typeRank: Record<EntityType, number> = { work: 0, person: 1, event: 2, organization: 3 };
  return typeRank[left.type] - typeRank[right.type] || left.index - right.index || left.tag.localeCompare(right.tag, "ja");
}

function normalizeEntityName(value: string) {
  const cleaned = value.trim().replace(/^[《〈「『【]+|[》〉」』】]+$/gu, "");
  return normalizeTagAliases(cleaned)[0] ?? "";
}

function normalizeTagAliases(value: string) {
  const tag = normalizeText(value);
  return TAG_ALIASES.get(tag) ?? [tag];
}

function isEntityMentioned(rawValue: string, canonicalTag: string, titles: string[]) {
  const titleKeys = titles.map(comparisonKey).filter(Boolean);
  const entityKeys = new Set([comparisonKey(rawValue), comparisonKey(canonicalTag)]);
  for (const alias of ALIAS_KEYS_BY_CANONICAL.get(canonicalTag) ?? []) entityKeys.add(comparisonKey(alias));
  return [...entityKeys].some((entityKey) => entityKey.length >= 2 && titleKeys.some((titleKey) => containsEntityKey(titleKey, entityKey)));
}

function containsEntityKey(titleKey: string, entityKey: string) {
  let start = titleKey.indexOf(entityKey);
  while (start >= 0) {
    const following = titleKey[start + entityKey.length] ?? "";
    // Do not treat an earlier franchise name as a title match merely because
    // it is the prefix of a numbered sequel (for example 食神 / 食神2026).
    if (!/[a-z0-9]/iu.test(following)) return true;
    start = titleKey.indexOf(entityKey, start + 1);
  }
  return false;
}

function comparisonKey(value: string) {
  return normalizeText(value).replace(/[\s・·_\-—―!！?？:：,，.。'"“”‘’「」『』《》〈〉【】（）()]/gu, "").toLocaleLowerCase("ja");
}

function isUsableTag(tag: string) {
  return Boolean(tag) && tag.length <= 24 && !/https?:|www\.|\.(?:com|cn|net|org)\b/iu.test(tag);
}

function isBroadOrLocation(tag: string) {
  return BROAD_TAGS.has(tag) || LOCATION_ONLY_TAGS.has(tag);
}

function isPlatformOrObservation(tag: string) {
  return PLATFORM_OR_OBSERVATION_TAGS.has(tag) || /^(?:微博|Weibo)(?:熱捜|热搜|トレンド)?$/iu.test(tag);
}

function normalizeText(value: string) {
  return convertDisplayText(value.normalize("NFKC").trim()).replace(/\s+/gu, " ");
}

function normalizedSet(values: string[]) {
  return new Set(values.map(normalizeText));
}

function buildAliasMap(rules: Array<[string[], string[]]>) {
  const aliases = new Map<string, string[]>();
  for (const [inputs, outputs] of rules) {
    const normalizedOutputs = outputs.map(normalizeText);
    for (const input of inputs) aliases.set(normalizeText(input), normalizedOutputs);
  }
  return aliases;
}

function buildAliasKeysByCanonical(rules: Array<[string[], string[]]>) {
  const byCanonical = new Map<string, string[]>();
  for (const [inputs, outputs] of rules) {
    if (outputs.length !== 1) continue;
    const canonical = normalizeText(outputs[0]);
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), ...inputs.map(normalizeText)]);
  }
  return byCanonical;
}

function countTagsByArticle(tagsByArticle: string[][]) {
  const counts = new Map<string, number>();
  for (const tags of tagsByArticle) {
    for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

function sourceNameKeys(value: string) {
  const normalized = normalizeText(value);
  return [
    sourceNameKey(normalized),
    sourceNameKey(normalized.replace(/(?:新聞|ニュース|娛樂|エンタメ|影視産業)$/u, ""))
  ].filter(Boolean);
}

function sourceNameKey(value: string) {
  return value.replace(/[\s・·_-]+/gu, "").toLocaleLowerCase("ja");
}
