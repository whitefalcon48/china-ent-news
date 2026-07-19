import assert from "node:assert/strict";
import { assessSourceRelevance, isSafePublicationSourceUrl, rankTopicSearchQueries } from "./sourceRelevance.js";
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
assert.equal(isSafePublicationSourceUrl("https://www.douyin.com/search/%E7%8E%8B%E5%B9%B4%E5%B0%86%E6%88%90"), false);
assert.equal(isSafePublicationSourceUrl("https://www.youtube.com/playlist?list=test"), false);
assert.equal(isSafePublicationSourceUrl("https://pic.rsvp-rentals.com/html/example.html"), false);
assert.equal(isSafePublicationSourceUrl("https://www.bjnews.com.cn/detail/example.html"), true);

console.log("source relevance: 7 cases passed");
