import { areTitlesSimilar } from "./dedupe.js";
import { consumeLlmCall, hasLlmBudgetRemaining, type LlmCallBudget } from "./llmCallBudget.js";
import { describeError, getAiProvider, getProviderEnvStatus } from "./summarizeWithGemini.js";
import type { PublicationHistoryMatch } from "./publicationHistory.js";
import type { AiProvider, SourceTypeLabel, TopicCandidate } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export type EditorialAxis = { score: number; reason: string };
export type EditorialValueAssessment = {
  topic_key: string;
  axes: {
    freshness_update: EditorialAxis;
    corroboration: EditorialAxis;
    local_heat: EditorialAxis;
    japan_value: EditorialAxis;
    bingtang_angle: EditorialAxis & { angle_hint: string };
  };
  total: number;
  caps: string[];
  result: "qualified" | "evs_below_threshold" | "official_only_limit";
};

export type EditorialValueResult = {
  llm: "ok" | "fallback";
  candidates: EditorialValueAssessment[];
};

type LlmScore = {
  topic_key?: string;
  japan_value?: number;
  japan_reason?: string;
  bingtang_angle?: number;
  angle_reason?: string;
  angle_hint?: string;
};

export async function evaluateEditorialValues(
  topics: TopicCandidate[],
  historyMatches: Map<string, PublicationHistoryMatch>,
  provider: AiProvider = getAiProvider(),
  budget?: LlmCallBudget
): Promise<EditorialValueResult> {
  const deterministic = topics.slice(0, 20).map((topic) => evaluateDeterministicAxes(topic, historyMatches.get(topic.topic_key)));
  const llmScores = await getLlmScores(topics.slice(0, 20), provider, budget);
  return {
    llm: llmScores.mode,
    candidates: deterministic.map(({ topic, a, b, c, caps }) => {
      const llm = llmScores.scores.get(topic.topic_key) ?? fallbackScore(topic);
      const rawTotal = a.score + b.score + c.score + llm.japan_value + llm.bingtang_angle;
      const total = caps.includes("single_source_cap") ? Math.min(rawTotal, 6) : rawTotal;
      return {
        topic_key: topic.topic_key,
        axes: {
          freshness_update: a,
          corroboration: b,
          local_heat: c,
          japan_value: { score: llm.japan_value, reason: llm.japan_reason },
          bingtang_angle: { score: llm.bingtang_angle, reason: llm.angle_reason, angle_hint: llm.angle_hint }
        },
        total,
        caps,
        result: total >= 7 ? "qualified" : "evs_below_threshold"
      };
    })
  };
}

export function isOfficialOnlyTopic(topic: TopicCandidate) {
  return topic.evidence_articles.length > 0 && topic.evidence_articles.every((item) => item.source_type === "official" || item.source_type === "pr_like");
}

export function getIndependentEvidence(topic: TopicCandidate) {
  const accepted: TopicCandidate["evidence_articles"] = [];
  for (const evidence of topic.evidence_articles) {
    if (accepted.some((item) => item.source_name === evidence.source_name)) continue;
    if (accepted.some((item) => areTitlesSimilar(item.title, evidence.title))) continue;
    accepted.push(evidence);
  }
  return accepted;
}

function evaluateDeterministicAxes(topic: TopicCandidate, historyMatch?: PublicationHistoryMatch) {
  const a = historyMatch
    ? { score: 2, reason: `A=2: 強い更新(${historyMatch.substantive_update})` }
    : ["today", "yesterday", "recent"].includes(topic.freshness_label)
      ? { score: 2, reason: `A=2: 履歴なし・新規${topic.freshness_label}` }
      : { score: 0, reason: `A=0: freshness ${topic.freshness_label}` };
  const independent = getIndependentEvidence(topic);
  const sourceTypes = [...new Set(independent.map((item) => item.source_type))];
  const exception = independent.length === 1 ? getSingleSourceException(independent[0]) : "";
  let b: EditorialAxis;
  const caps: string[] = [];
  if (independent.length >= 2 && sourceTypes.length >= 2) b = { score: 2, reason: `B=2: 独立${independent.length}ソース(${sourceTypes.join(",")})` };
  else if (independent.length >= 2) b = { score: 1, reason: `B=1: 独立${independent.length}ソース(${sourceTypes[0] ?? "unknown"})` };
  else if (exception) {
    b = { score: 1, reason: `B=1: 単一ソース例外(${exception})` };
    caps.push(`single_source_exception:${exception}`);
  } else {
    b = { score: 0, reason: "B=0: 単一ソース・例外なし" };
    caps.push("single_source_cap");
  }

  const mediaText = independent.filter((item) => item.source_type === "media_report").map((item) => `${item.title} ${item.key_points.join(" ")}`).join(" ");
  const hasHeatData = independent.some((item) => item.source_type === "data" && /评分|評分|热度|熱度|豆瓣|猫眼|熱搜|热搜/.test(`${item.title} ${item.key_points.join(" ")}`));
  const hasSns = independent.some((item) => item.source_type === "sns");
  const c = hasSns || hasHeatData
    ? { score: 2, reason: `C=2: ${hasSns ? "SNS/热搜 evidence" : "評分・熱度data"}` }
    : /引发|热议|回应|争议|刷屏/.test(mediaText)
      ? { score: 1, reason: "C=1: 媒体が反応・議論を報道" }
      : { score: 0, reason: "C=0: 現地反応evidenceなし" };
  return { topic, a, b, c, caps };
}

function getSingleSourceException(evidence: TopicCandidate["evidence_articles"][number]) {
  if (evidence.source_type === "media_report" && (evidence.article_type === "interview" || /专访|独家|调查|评论/.test(evidence.title)) && ["A", "B"].includes(evidence.reliability)) return "original_reporting";
  if (evidence.source_type === "official" && /备案|许可|名单|公示|数据/.test(evidence.title)) return "official_primary_release";
  return "";
}

async function getLlmScores(topics: TopicCandidate[], provider: AiProvider, budget?: LlmCallBudget) {
  const fallback = new Map(topics.map((topic) => [topic.topic_key, fallbackScore(topic)]));
  if (!topics.length || !getProviderEnvStatus(provider).hasApiKey || (budget && !hasLlmBudgetRemaining(budget))) return { mode: "fallback" as const, scores: fallback };
  try {
    if (budget) consumeLlmCall(budget);
    const text = await generateJson(provider, buildPrompt(topics));
    const parsed = parseJson(text) as { scores?: LlmScore[] };
    const scores = new Map<string, ReturnType<typeof fallbackScore>>();
    for (const item of parsed.scores ?? []) {
      if (!item.topic_key || !topics.some((topic) => topic.topic_key === item.topic_key)) continue;
      scores.set(item.topic_key, {
        japan_value: clampScore(item.japan_value),
        japan_reason: cleanReason(item.japan_reason),
        bingtang_angle: clampScore(item.bingtang_angle),
        angle_reason: cleanReason(item.angle_reason),
        angle_hint: typeof item.angle_hint === "string" ? item.angle_hint.trim().slice(0, 30) : ""
      });
    }
    if (scores.size !== topics.length) return { mode: "fallback" as const, scores: fallback };
    return { mode: "ok" as const, scores };
  } catch (error) {
    console.warn(`EVS LLM fallback: ${describeError(error)}`);
    return { mode: "fallback" as const, scores: fallback };
  }
}

function fallbackScore(topic: TopicCandidate) {
  const japanValue = topic.japan_gap === "high" ? 2 : topic.japan_gap === "medium" ? 1 : 0;
  return {
    japan_value: japanValue,
    japan_reason: `fallback: japan_gap=${topic.japan_gap}`,
    bingtang_angle: 1,
    angle_reason: "fallback: 補足余地を1点で仮評価",
    angle_hint: ""
  };
}

function buildPrompt(topics: TopicCandidate[]) {
  const candidates = topics.map((topic) => ({
    topic_key: topic.topic_key,
    title: topic.title_hint,
    event_sentence: topic.event_sentence,
    topic_type: topic.topic_type,
    entities: topic.main_entities,
    source_composition: summarizeSourceMix(topic.source_mix),
    key_points: topic.evidence_articles.flatMap((item) => item.key_points).slice(0, 8)
  }));
  return `あなたは中国エンタメニュースの編集価値を採点する編集AIです。以下の候補トピックそれぞれについて、2つの軸を0〜2点で採点します。

このサイトの目的: 中国現地で実際に評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋める。読者は中国エンタメに関心のある日本語話者。

軸D: 日本語圏へ渡す意味・補足価値（0〜2）
- 2: 日本語圏ではほぼ報じられない・見えにくい話で、知る価値がはっきりある（現地で大きい出来事、日本と関係が生じる話、日本の中国エンタメファンの関心事）
- 1: 日本語圏でも部分的に知られているが、現地文脈の補足に価値がある
- 0: 日本語圏の読者に渡す意味が薄い（ローカルすぎる行政話題、単なる番組告知、内輪ネタ）

軸E: ビンタン独自の解説・観察を乗せられるか（0〜2）
- 2: 制度・業界慣行・ファン文化・数字の読み方など、噛み砕き解説や独自の見方をはっきり乗せられる
- 1: 多少の文脈補足はできるが、本文以上のことは言いにくい
- 0: 事実を言い換える以外にコメントの余地がない

規則:
- 評価は与えられた情報（タイトル・出来事・エンティティ・ソース構成・key_points）だけで行う。知らない作品・人物を知っているかのように評価しない。
- japan_reason / angle_reason は40字以内。
- angle_hint には、ビンタンがコメントで扱える具体的な切り口を30字以内で入れる（bingtang_angle が1以上のときだけ。0のときは空文字）。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "scores": [
    { "topic_key": "", "japan_value": 0, "japan_reason": "", "bingtang_angle": 0, "angle_reason": "", "angle_hint": "" }
  ]
}

候補一覧:
${JSON.stringify(candidates, null, 2)}`;
}

function summarizeSourceMix(sourceMix: Record<SourceTypeLabel, number>) {
  return Object.entries(sourceMix).filter(([, count]) => count > 0).map(([type, count]) => `${type}:${count}`).join(", ");
}

async function generateJson(provider: AiProvider, prompt: string) {
  if (provider === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey?.trim()) throw new Error("DEEPSEEK_API_KEY is not set");
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1, response_format: { type: "json_object" } })
    });
    if (!response.ok) throw new Error(`DeepSeek EVS API error: HTTP ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content ?? "";
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 }, contents: [{ role: "user", parts: [{ text: prompt }] }] })
  });
  if (!response.ok) throw new Error(`Gemini EVS API error: HTTP ${response.status} ${response.statusText}`);
  const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
}

function parseJson(text: string) {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

function clampScore(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(2, Math.round(number))) : 0;
}

function cleanReason(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 40) : "";
}
