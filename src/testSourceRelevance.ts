import assert from "node:assert/strict";
import { assessClaimCoverage } from "./evidence/claimCoverage.js";
import { assessSourceRelevance, inferRelatedAngleKind, isSafePublicationSourceUrl, rankRelatedAngleSearchQueries, rankTopicSearchQueries } from "./sourceRelevance.js";
import type { SourceExpansionEvidence, TopicCandidate } from "./types.js";

const baseTopic = {
  topic_key: "王年将成",
  title_hint: "从绿茵场到片场，王年将成：不过是换了片赛场丨短剧演员说",
  search_queries: ["王年将成", "王年将成 短剧演员", "足球运动员 转型 短剧", "王年将成 短剧"],
  main_entities: { people: ["王年将成"], works: [], organizations: [], events: ["王年将成从绿茵场到片场"] }
} as unknown as TopicCandidate;

function evidence(title: string, url: string): SourceExpansionEvidence {
  return { title, url, source_name: "test", source_type: "media_report", route_id: "test", route: "test", query: "", key_points: [title] };
}

assert.deepEqual(rankTopicSearchQueries(baseTopic).slice(0, 2), ["足球运动员 转型 短剧", "王年将成 短剧演员"]);
assert.equal(assessSourceRelevance(baseTopic, evidence("前中超门将王年将成开始拍短剧了！自称此前工资约3000元", "https://example.com/relevant"), "足球运动员 转型 短剧").accepted, true);
assert.equal(assessSourceRelevance(baseTopic, evidence("短剧演员王年将成拍摄时意外受伤", "https://example.com/other-event"), "王年将成 短剧演员").accepted, false);

const summerBoxOfficeTopic = {
  ...baseTopic,
  topic_type: "box_office",
  topic_key: "2026年暑期档电影票房",
  title_hint: "2026暑期档电影票房超92亿元",
  event_sentence: "2026年暑期档映画興行収入が92億元を超えた",
  search_queries: ["暑期档电影票房超92亿"],
  main_entities: { people: [], works: [], organizations: [], events: ["2026年暑期档"] }
} as unknown as TopicCandidate;
assert.equal(
  assessSourceRelevance(summerBoxOfficeTopic, evidence("2026暑期档票房突破92亿元，连续34天单日票房超亿元", "https://example.com/box-office"), "暑期档电影票房超92亿").accepted,
  true,
  "an unspaced Chinese query and 超/突破 wording variants reach full-page validation"
);
assert.equal(
  assessSourceRelevance(summerBoxOfficeTopic, {
    ...evidence("暑期档市场最新观察", "https://example.com/snippet-match"),
    key_points: ["截至8月13日晚，2026暑期档票房突破92亿元，连续34天单日票房超亿元。"]
  }, "暑期档电影票房超92亿").accepted,
  true,
  "Serper snippets may admit a candidate to full-page validation but never become evidence themselves"
);
assert.equal(
  assessSourceRelevance(summerBoxOfficeTopic, evidence("2026暑期档票房突破192亿元", "https://example.com/wrong-central-number"), "暑期档电影票房超92亿").accepted,
  false,
  "192亿元 must not consume a full-page validation slot for the 92亿元 event"
);
for (const [amount, expected] of [["92亿元", true], ["92亿", true], ["90亿元", false], ["80亿元", false], ["192亿元", false], ["920亿元", false]] as const) {
  const coverage = assessClaimCoverage(summerBoxOfficeTopic, {
    title: `2026暑期档票房突破${amount}`,
    text: `截至8月13日，2026暑期档票房突破${amount}，影片持续上映。`
  });
  assert.equal(coverage.matched, expected, `${amount} must ${expected ? "match" : "not match"} the central 92亿元 claim`);
}
assert.deepEqual(rankRelatedAngleSearchQueries(summerBoxOfficeTopic).slice(0, 3), [
  "2026年暑期档 热搜", "2026年暑期档 热议", "2026年暑期档 观众讨论"
], "aggregate events also receive bounded reception queries");
assert.equal(
  assessSourceRelevance(summerBoxOfficeTopic, evidence("2026暑期档票房话题引发观众讨论", "https://example.com/summer-reaction"), "2026年暑期档 观众讨论", "related_angle").accepted,
  true,
  "2026年暑期档 and 2026暑期档 are the same event anchor"
);
assert.equal(
  assessSourceRelevance(summerBoxOfficeTopic, evidence("2026年暑期档票房突破80亿", "https://example.com/not-hot-search"), "2026年暑期档 热搜", "related_angle").accepted,
  false,
  "an event match alone cannot masquerade as a hot-search observation"
);

const liXuejianTopic = {
  ...baseTopic,
  topic_key: "李雪健抗癌26年听力下降",
  title_hint: "李雪健双耳已完全听不见",
  event_sentence: "李雪健の聴力低下について伝えられた",
  search_queries: ["李雪健 听力下降", "李雪健 抗癌经历"],
  evidence_articles: [{ article_type: "interview" }],
  main_entities: { people: ["李雪健"], works: ["流浪地球3"], organizations: [], events: [] }
} as unknown as TopicCandidate;
assert.equal(
  assessSourceRelevance(liXuejianTopic, evidence("抗癌26年，李雪健的双耳已经完全听不见了", "https://example.com/li"), "李雪健 听力下降").accepted,
  true,
  "a canonical person plus a distinctive condition is a sufficiently specific match"
);
assert.deepEqual(
  rankRelatedAngleSearchQueries(liXuejianTopic).slice(0, 4),
  ["李雪健 听力 热搜", "李雪健 听力 热议", "李雪健 听力 回应", "李雪健 听力 讨论"],
  "manual interview research prioritizes verified reception around the person, not generic work box office"
);
assert.equal(
  assessSourceRelevance(baseTopic, evidence("王年将成新短剧作品引发粉丝讨论", "https://example.com/related"), "王年将成 粉丝", "related_angle").reason,
  "accepted_related_entity_and_angle",
  "related-angle discovery needs both the canonical person/work and its requested angle"
);
assert.equal(
  assessSourceRelevance(liXuejianTopic, evidence("李雪健戴五星红旗徽章领金马奖引发热议", "https://example.com/old-reaction"), "李雪健 听力 热议", "related_angle").accepted,
  false,
  "an old unrelated reaction about the same person cannot become the current interview's reception"
);
assert.equal(
  assessSourceRelevance(liXuejianTopic, evidence("李雪健双耳已完全听不见冲上热搜", "https://example.com/current-reaction"), "李雪健 听力 热搜", "related_angle").accepted,
  true,
  "a reception document must contain both the person and this root event's distinctive context"
);
assert.equal(
  assessSourceRelevance(baseTopic, evidence("另一位演员的粉丝讨论", "https://example.com/unrelated"), "王年将成 粉丝", "related_angle").reason,
  "related_missing_canonical_entity",
  "a related-angle result without the canonical entity must remain diagnostic-only"
);
assert.deepEqual(
  rankRelatedAngleSearchQueries(baseTopic).slice(0, 2),
  ["王年将成 作品", "王年将成 粉丝"],
  "related-angle queries use a canonical entity plus an explicit angle"
);

const kungFuTopic = {
  ...baseTopic,
  topic_key: "功夫女足上映",
  title_hint: "《功夫女足》正式上映",
  event_sentence: "映画『功夫女足』の公開が発表された",
  search_queries: ["功夫女足 上映"],
  main_entities: { people: [], works: ["功夫女足"], organizations: [], events: ["功夫女足上映"] }
} as unknown as TopicCandidate;
const kungFuBoxOffice = evidence("《功夫女足》票房突破，観客の口コミも話題に", "https://example.com/kungfu-boxoffice");
assert.deepEqual(
  rankRelatedAngleSearchQueries(kungFuTopic).slice(0, 2),
  ["功夫女足 口碑", "功夫女足 票房"],
  "work topics explore at least two independent angles by default"
);
assert.equal(
  assessSourceRelevance(kungFuTopic, kungFuBoxOffice, "功夫女足 票房", "related_angle").reason,
  "accepted_related_entity_and_angle",
  "a box-office angle is a valid related discovery for 功夫女足"
);
assert.equal(
  assessSourceRelevance(kungFuTopic, kungFuBoxOffice, "功夫女足 上映", "corroboration").accepted,
  false,
  "a different angle cannot corroborate the original release claim"
);
assert.equal(
  assessClaimCoverage(kungFuTopic, { title: kungFuBoxOffice.title, text: "《功夫女足》票房突破，観客の口コミも話題に" }).matched,
  false,
  "claim coverage also rejects the different box-office claim"
);

const xieXianTopic = {
  ...baseTopic,
  topic_key: "谢贤逝世",
  title_hint: "谢贤逝世",
  event_sentence: "香港俳優の谢贤が逝世したと報じられた",
  search_queries: ["谢贤 逝世", "谢贤 去世"],
  main_entities: { people: ["谢贤", "谢霆锋"], works: [], organizations: [], events: ["谢贤逝世"] }
} as unknown as TopicCandidate;
assert.deepEqual(
  rankRelatedAngleSearchQueries(xieXianTopic).slice(0, 2),
  ["谢贤 回应", "谢贤 生涯"],
  "an obituary root searches family or peer responses and a career retrospective first"
);
assert.equal(inferRelatedAngleKind("谢贤 回应"), "person_response");
assert.equal(inferRelatedAngleKind("谢贤 生涯回顾"), "career_retrospective");
assert.equal(isSafePublicationSourceUrl("https://www.douyin.com/search/%E7%8E%8B%E5%B9%B4%E5%B0%86%E6%88%90"), false);
assert.equal(isSafePublicationSourceUrl("https://www.youtube.com/playlist?list=test"), false);
assert.equal(isSafePublicationSourceUrl("https://pic.rsvp-rentals.com/html/example.html"), false);
assert.equal(isSafePublicationSourceUrl("https://www.bjnews.com.cn/detail/example.html"), true);

console.log("source relevance: related-angle separation checks passed");
