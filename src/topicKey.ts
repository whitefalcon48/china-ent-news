const KNOWN_TOPICS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /上海国际电影节|上影节|金爵奖/, key: "上海国际电影节" },
  { pattern: /大众电影百花奖|百花奖/, key: "大众电影百花奖" }
];

const KNOWN_EVENTS = ["上海国际电影节", "北京国际电影节", "白玉兰奖", "华表奖", "金鸡奖", "微博电影之夜", "微博视界大会"];

export function createTopicKey(title: string, excerpt = "") {
  const text = `${title} ${excerpt}`;

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
  return match?.[1] ?? "";
}

function extractTitleKeywords(title: string) {
  return title
    .split(/[：:，,。；;！!？?、｜|]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
}

export function cleanTopicKey(value: string) {
  return value.replace(/\s+/g, "").slice(0, 40) || "unknown";
}
