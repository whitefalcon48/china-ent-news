import type { FactLedger, ToneMode, TopicCandidate } from "./types.js";

const CHINESE_SOBER = /违纪|违法|被查|被捕|逮捕|拘留|起诉|判决|诉讼|犯罪|吸毒|嫖娼|偷税|逃税|性侵|家暴|猥亵|去世|离世|逝世|病逝|自杀|遇难|身亡|受害|遇害|事故|灾害|地震|火灾/;
const JAPANESE_SOBER = /規律違反|審査調査|起訴|判決|訴訟|脱税|性加害|性暴力|死去|死亡|訃報|自殺|被害|事故/;

export function getToneMode(topic: TopicCandidate, ledger?: FactLedger): ToneMode {
  const text = [topic.topic_key, topic.event_sentence, ...(ledger?.claims.map((claim) => claim.text) || [])].join("\n");
  return CHINESE_SOBER.test(text) || JAPANESE_SOBER.test(text) ? "sober" : "normal";
}
