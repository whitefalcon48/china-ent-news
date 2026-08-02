import type { InterestFeatureId, InterestFeatureMatch, PreferenceCandidate } from "./types.js";

type Rule = {
  id: InterestFeatureId;
  test: (text: string) => string[];
};

const rules: Rule[] = [
  {
    id: "people_milestone_and_direct_words",
    test: (text) => collect(text, [
      [/(讣告|逝世|去世|离世|悼念|追思)/, "milestone_or_obituary"],
      [/(发文|发声|回应|致辞|表示|谈及|说过|说：)/, "direct_words_or_response"]
    ], 2)
  },
  {
    id: "feminist_film_and_formal_screening",
    test: feministFilmAndFormalScreening
  },
  {
    id: "release_schedule_change",
    test: (text) => collect(text, [
      [/(撤档|改档|延期|延后|推迟|档期变更|延播|延映|重新定档)/, "release_schedule_change"]
    ], 1)
  },
  {
    id: "international_cultural_circulation",
    test: (text) => collect(text, [
      [/(电影节|影展|文化交流|中国电影周|海外展映|国际巡回|驻外使馆|使领馆)/, "cross_border_cultural_event"],
      [/(尼日尔|海外|国际|驻外|非洲|拉美|欧洲|东南亚)/, "cross_border_context"]
    ], 2)
  },
  {
    id: "audiovisual_ai_technology",
    test: (text) => collect(text, [
      [/(人工智能|AI|大模型|AIGC|智能生成)/i, "ai"],
      [/(广播电视|网络视听|视听|影视|电视剧|视频)/, "audiovisual_context"]
    ], 2)
  },
  {
    id: "fan_culture_online_expression",
    test: (text) => collect(text, [
      [/(表情包|名场面|热梗|二创|玩梗|迷因|meme)/i, "online_expression"],
      [/(粉丝|饭圈|热搜|网友|社媒|微博|抖音)/, "fan_or_social_context"]
    ], 2)
  },
  {
    id: "private_life_careful",
    test: (text) => collect(text, [
      [/(离婚|共同育儿|孩子|家庭|婚姻|恋情|前夫|前妻)/, "private_life_context"]
    ], 1)
  }
];

/**
 * Tags only express possible reader interest. They make no factual claim and
 * do not alter eligibility, EVS, claim checks, safety, or publication gates.
 */
export function classifyInterestFeatures(candidate: PreferenceCandidate): InterestFeatureMatch[] {
  const text = [
    candidate.title,
    candidate.event_sentence ?? "",
    ...(candidate.search_queries ?? []),
    ...(candidate.entities ?? []),
    ...(candidate.evidence_text ?? [])
  ].join("\n");
  return rules
    .map((rule) => ({ id: rule.id, reasons: rule.test(text) }))
    .filter((match): match is InterestFeatureMatch => match.reasons.length > 0);
}

function feministFilmAndFormalScreening(text: string): string[] {
  // "Inter Alia / 非穷尽列举" is intentionally narrow: it must be treated as
  // a feminist, film-discussion work formally screened in China, never as a
  // generic foreign stage-performance preference.
  const isInterAlia = /(非穷尽列举|非窮盡列舉|inter\s*alia)/i.test(text);
  const formalScreening = /(正式上映|正式放映|上映|放映|展映|排片|影院)/.test(text);
  const filmAndFeminism = /(电影|影片|影迷|电影节|女性主义|女权|性别|feminis[mt])/.test(text);
  return isInterAlia && formalScreening && filmAndFeminism
    ? ["inter_alia_named", "formal_screening", "feminist_or_film_context"]
    : [];
}

function collect(text: string, checks: Array<[RegExp, string]>, required: number): string[] {
  const reasons = checks.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  return reasons.length >= required ? reasons : [];
}
