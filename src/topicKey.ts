const KNOWN_TOPICS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /上海国际电影节|上影节|金爵奖/, key: "上海国际电影节" },
  { pattern: /大众电影百花奖|百花奖/, key: "大众电影百花奖" }
];

const KNOWN_EVENTS = ["上海国际电影节", "北京国际电影节", "白玉兰奖", "华表奖", "金鸡奖", "微博电影之夜", "微博视界大会"];

const DEATH_EVENT_PATTERN = /逝世|去世|离世|辞世|病逝/;
// These terms mean that the article's primary claim is an angle that follows the
// death report (a reaction, estate story, or funeral), rather than the death
// report itself.  Such an article may be related, but must not become an
// additional confirmation of the root death claim merely through topic grouping.
const DEATH_FOLLOW_UP_ANGLE_PATTERN = /回应|发声|谈及|透露|辟谣|否认|澄清|悼念|追忆|回忆|遗产|遗嘱|争产|葬礼|丧礼|出殡|告别式|追思会/;
const DEATH_FOLLOW_UP_ANGLE_LABELS: Array<[RegExp, string]> = [
  [/回应|发声|谈及|透露/, "回应"],
  [/辟谣|否认|澄清/, "回应"],
  [/悼念|追忆|回忆|追思会/, "悼念"],
  [/遗产|遗嘱|争产/, "遗产"],
  [/葬礼|丧礼|出殡|告别式/, "葬礼"]
];

export type TopicKeyInput = {
  topicKey?: string;
  title: string;
  excerpt?: string;
  people?: string[];
  works?: string[];
};

type ComparableTopic = {
  topic_key: string;
  topic_type: string;
  main_entities?: { people?: string[]; works?: string[] };
  entities?: { people?: string[]; works?: string[] };
};

export function areTopicsLikelySame(a: ComparableTopic, b: ComparableTopic) {
  return getTopicMatchSpecificity(a, b) > 0;
}

export function getTopicMatchSpecificity(a: ComparableTopic, b: ComparableTopic) {
  const aKey = normalizeComparisonValue(a.topic_key);
  const bKey = normalizeComparisonValue(b.topic_key);
  if (aKey === bKey) return 3;
  if (!a.topic_type || a.topic_type === "unknown" || a.topic_type !== b.topic_type) return 0;
  const shorterKey = aKey.length <= bKey.length ? aKey : bKey;
  const longerKey = aKey.length > bKey.length ? aKey : bKey;
  if (shorterKey.length >= 6 && longerKey.includes(shorterKey)) return 2;
  const aEntities = getComparableEntities(a);
  const bEntities = getComparableEntities(b);
  return aEntities.some((entity) => bEntities.includes(entity)) ? 1 : 0;
}

export function createTopicKey(title: string, excerpt = "") {
  const text = `${title} ${excerpt}`;

  const deathEvent = getCanonicalDeathEventKey(text);
  if (deathEvent) {
    return deathEvent.key;
  }

  const known = KNOWN_TOPICS.find((topic) => topic.pattern.test(text));
  if (known) {
    return known.key;
  }

  const work = extractWorkName(text);
  if (work) {
    return cleanTopicKey(work);
  }

  const event = extractEventName(text);
  if (event) {
    return cleanTopicKey(event);
  }

  const policy = extractPolicyKey(title);
  if (policy) {
    return cleanTopicKey(policy);
  }

  const person = extractPersonName(text);
  if (person) {
    return cleanTopicKey(person);
  }

  const quoted = title.match(/[“「『]([^”」』]+)[”」』]/)?.[1];
  if (quoted) {
    return cleanTopicKey(quoted);
  }

  return cleanTopicKey(extractTitleKeywords(title) || title);
}

/**
 * Resolves the stable key used to group evidence into a topic candidate.
 *
 * Topic-seed LLM output remains authoritative for normal topics.  The one
 * exception is a direct death report: synonymous event words such as 去世 and
 * 逝世 are normalized to "<person>逝世".  Follow-up angles deliberately retain a
 * more specific key, so a family's reaction or an inheritance story cannot be
 * counted as corroboration of the death itself.
 */
export function getCanonicalTopicKey(input: TopicKeyInput) {
  const suppliedKey = input.topicKey ?? "";
  const text = [suppliedKey, input.title, input.excerpt ?? ""].filter(Boolean).join(" ");
  const people = uniqueCleanValues(input.people ?? []);
  const deathEvent = getCanonicalDeathEventKey(text, people);
  if (deathEvent) {
    const followUp = getDeathFollowUpAngle(text, deathEvent.person, people);
    return followUp ? cleanTopicKey(`${deathEvent.key}-${followUp}`) : deathEvent.key;
  }
  return cleanTopicKey(suppliedKey || createTopicKey(input.title, input.excerpt ?? ""));
}

type CanonicalDeathEvent = {
  key: string;
  person: string;
};

function getCanonicalDeathEventKey(text: string, suppliedPeople: string[] = []): CanonicalDeathEvent | null {
  if (!DEATH_EVENT_PATTERN.test(text)) return null;
  const person = extractDeathEventPerson(text, suppliedPeople);
  return person ? { person, key: cleanTopicKey(`${person}逝世`) } : null;
}

function extractDeathEventPerson(text: string, suppliedPeople: string[]) {
  const directSuppliedPerson = suppliedPeople.find((person) => isDirectDeathSubject(text, person));
  if (directSuppliedPerson) return directSuppliedPerson;

  const match = text.match(/(?:^|[^\p{Script=Han}])([\p{Script=Han}]{2,12})(?:因病)?(?:逝世|去世|离世|辞世|病逝)/u);
  const candidate = stripPersonRolePrefix(match?.[1] ?? "");
  return isLikelyPersonName(candidate) ? candidate : "";
}

function isDirectDeathSubject(text: string, person: string) {
  return new RegExp(`${escapeRegExp(person)}(?:因病)?(?:逝世|去世|离世|辞世|病逝)`).test(text);
}

function getDeathFollowUpAngle(text: string, deceased: string, people: string[]) {
  if (!DEATH_FOLLOW_UP_ANGLE_PATTERN.test(text)) return "";
  const label = DEATH_FOLLOW_UP_ANGLE_LABELS.find(([pattern]) => pattern.test(text))?.[1] ?? "后续";
  const actor = people.find((person) => person !== deceased && isDeathFollowUpActor(text, person)) || extractDeathFollowUpActor(text, deceased);
  return actor ? `${actor}${label}` : label;
}

function isDeathFollowUpActor(text: string, person: string) {
  return new RegExp(`${escapeRegExp(person)}(?:就|对|称|发文|本人)?(?:回应|发声|谈及|透露|悼念|追忆|回忆|否认|澄清)`).test(text);
}

function extractDeathFollowUpActor(text: string, deceased: string) {
  const match = text.match(/([\p{Script=Han}]{2,12})(?:就|对|称|发文|本人)?(?:回应|发声|谈及|透露|悼念|追忆|回忆|否认|澄清)/u);
  const candidate = stripPersonRolePrefix(match?.[1] ?? "");
  return candidate && candidate !== deceased && isLikelyPersonName(candidate) ? candidate : "";
}

function stripPersonRolePrefix(value: string) {
  return value.replace(/^(?:著名|香港|港|中国|内地|资深|老牌|老戏骨|演员|艺人|影星|导演|歌手|其子|其女|儿子|女儿)+/u, "");
}

function isLikelyPersonName(value: string) {
  return /^[\p{Script=Han}]{2,4}$/u.test(value) && !isLikelyInvalidPersonName(value);
}

function uniqueCleanValues(values: string[]) {
  return [...new Set(values.map(cleanTopicKey).filter(isLikelyPersonName))];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractWorkName(text: string) {
  return text.match(/《([^》]{2,40})》/)?.[1] ?? text.match(/『([^』]{2,40})』/)?.[1] ?? "";
}

export function extractEventName(text: string) {
  const known = KNOWN_EVENTS.find((event) => text.includes(event));
  if (known) {
    return known;
  }
  return text.match(/([\p{Script=Han}A-Za-z0-9]{2,24}(?:电影节|电视节|影展|电影周|颁奖礼|电影之夜|视界大会))/u)?.[1] ?? "";
}

// Policy/administrative announcements are event-granular: each 公示/通知 document is
// its own topic, so key on the title clause that contains the policy keyword instead
// of a short regex fragment (which produced keys like "国家广播电视总局举行").
export function extractPolicyKey(title: string) {
  if (!/备案|公示|微短剧|网络剧|广播电视|国家电影局|国家广播电视总局|网络视听|管理办法|制作标准|技术要求|征求意见/.test(title)) {
    return "";
  }
  const clauses = title
    .split(/[，。；：！？!?、｜|\s]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const clause = clauses.find((part) => /备案|公示|微短剧|网络剧|管理办法|制作标准|技术要求|征求意见|广播电视|网络视听/.test(part));
  return clause ?? title;
}

export function extractPersonName(text: string) {
  const match =
    text.match(/([\p{Script=Han}]{2,4})(?:主演|导演|执导|获奖|官宣|发文|回应|出任|亮相|加盟|献唱|发布)/u) ??
    text.match(/(?:主演|导演|演员|歌手|艺人)([\p{Script=Han}]{2,4})/u);
  const candidate = match?.[1] ?? "";
  return isLikelyInvalidPersonName(candidate) ? "" : candidate;
}

function isLikelyInvalidPersonName(value: string) {
  return !value || /电影|电视|网剧|短剧|综艺|艺人|明星|演唱|唱会|版权|票房|发布|预告|首映|观众|粉丝|角色|合作/.test(value);
}

function extractTitleKeywords(title: string) {
  return title
    .split(/[：:，,。；;！!？?、｜|]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
}

export function cleanTopicKey(value: string) {
  const cleaned = value.replace(/\s+/g, "").replace(/演唱会高翻唱率/g, "演唱会翻唱版权").replace(/高翻唱率/g, "翻唱率");
  return cleaned.slice(0, 40) || "unknown";
}

function getComparableEntities(topic: ComparableTopic) {
  const entities = topic.main_entities ?? topic.entities ?? {};
  return [...new Set([...(entities.works ?? []), ...(entities.people ?? [])].map(normalizeComparisonValue).filter(Boolean))];
}

function normalizeComparisonValue(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[《》『』「」“”‘’'"・·\s\p{P}\p{S}]/gu, "");
}
