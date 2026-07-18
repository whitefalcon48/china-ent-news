import fs from "node:fs/promises";
import path from "node:path";
import { consumeLlmCall, LlmCallBudgetExceededError, type LlmCallBudget } from "./llmCallBudget.js";
import { describeError, formatEvidenceForPrompt } from "./summarizeWithGemini.js";
import type { AiProvider, ClaimType, FactLedger, FactLedgerClaim, RawArticle, TopicCandidate } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export type FactLedgerExtractionResult = { succeeded: boolean; ledger?: FactLedger; error: string };

export async function extractFactLedger(
  topic: TopicCandidate,
  evidence: RawArticle[],
  provider: AiProvider,
  budget?: LlmCallBudget
): Promise<FactLedgerExtractionResult> {
  try {
    const prompt = buildFactLedgerPrompt(topic, evidence);
    const text = provider === "deepseek"
      ? await generateDeepSeekJson(prompt, budget)
      : await generateGeminiJson(prompt, budget);
    return {
      succeeded: true,
      ledger: normalizeFactLedger(parseJsonFromModelText(text), topic.topic_key, evidenceText(evidence)),
      error: ""
    };
  } catch (error) {
    const detail = describeError(error);
    return {
      succeeded: false,
      error: error instanceof LlmCallBudgetExceededError ? `llm_call_budget_exceeded: ${detail}` : detail
    };
  }
}

export async function writeFactLedgerFile(
  ledgers: Array<{ topic_key: string; ledger: FactLedger | null; fallback_reason: string }>,
  date = today()
): Promise<string> {
  const outputPath = path.resolve("output", `fact_ledger_${date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify({ date, generated_at: new Date().toISOString(), ledgers }, null, 2)}\n`,
    "utf8"
  );
  return outputPath;
}

function buildFactLedgerPrompt(topic: TopicCandidate, evidence: RawArticle[]) {
  return `あなたは中国エンタメニュースの事実整理AIです。1つのトピックと複数のevidenceから、後工程が日本語記事を書くための「事実台帳」をJSONで作ります。

最重要ルール: 後工程はこの台帳だけを使って記事を書き、台帳に無い情報は一切書けません。evidenceにある重要情報を漏らさず、evidenceに無い情報を混ぜないでください。

claimの分類（type）:
- verified_fact: evidenceに直接書かれている日付・数字・人物・組織・出来事。
- source_analysis: 元媒体による分析・見方・評価・将来予測。source_name（媒体名）を必ず入れる。
- unsupported: evidence中に現れるが根拠が確認できない情報（伝聞、真偽不明の噂など）。記事には使われない。

規則:
- claimのtextは必ず日本語1文で書く。中国語の文をそのまま写さない（人名・作品名などの固有名詞は原文表記のままでよい）。
- claimは1件1文。重要な順に最大20件。
- entities（人物・作品・組織の固有名詞）とnumbers（数字・日付）は原文の表記のまま入れる。claimの文中に出てくる数字・日付・序数（第八届など）は必ずnumbersにも入れる。
- quote_zhには根拠となる原文の該当箇所を30字以内で入れる。
- evidence_refsには根拠のevidence番号（"E1"など）を必ず入れる。
- このトピックの中心にある制度・仕組み・業界用語について、evidenceが「それが何か」「なぜ問題・重要なのか」「どう機能するのか」を説明している場合、その説明を必ずclaimとして拾う。用語の説明はニュースの理解に不可欠な情報として扱う。
- 日本での公開・配信・日本語字幕に関する情報がevidenceに明示されている場合のみ、japan_availabilityのstatusを "verified" にし、detailに内容、evidence_refsに根拠を入れる。evidenceに無ければ status は "not_in_evidence"、detailは空文字。推測で "verified" にしない。日本に関する言及が無いことは「日本未公開」を意味しない。
- terms には、このevidenceの本文に実際に登場する中国エンタメ用語のうち、日本の読者に説明が必要なものだけを入れる（最大8件）。evidenceに登場しない用語を入れない。一般的な用語例からの丸写しをしない。
  - gloss_ja: 短い日本語訳（20字以内）。
  - what_is: その用語が指す仕組み・制度の説明（40字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - why_now: 今回のニュースでその用語がなぜ重要かの説明（60字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - what_is / why_now を一般知識で補完しない。evidenceに書かれていることだけを使う。
- evidence間で数字・日付・事実が食い違う場合は unresolved に1行で記す。どちらかへ勝手に寄せない。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "topic_key": "<入力値をそのまま>",
  "claims": [{ "id": "C1", "type": "verified_fact", "text": "", "evidence_refs": ["E1"], "source_name": "", "entities": [], "numbers": [], "quote_zh": "" }],
  "terms": [{ "term": "", "gloss_ja": "", "what_is": "", "why_now": "" }],
  "japan_availability": { "status": "not_in_evidence", "detail": "", "evidence_refs": [] },
  "unresolved": []
}

入力トピック:
- topic_key: ${topic.topic_key}
- event_sentence: ${topic.event_sentence}
- topic_type: ${topic.topic_type}

evidence一覧:
${formatEvidenceForPrompt(evidence)}`;
}

export function normalizeFactLedger(value: unknown, topicKey: string, evidence: string): FactLedger {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawClaims = Array.isArray(object.claims) ? object.claims : [];
  const claims = rawClaims.slice(0, 20).map((item, index) => normalizeClaim(item, index));
  const rawTerms = Array.isArray(object.terms) ? object.terms : [];
  const terms = rawTerms
    .slice(0, 8)
    .map((item) => {
      const term = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        term: toText(term.term),
        gloss_ja: toText(term.gloss_ja).slice(0, 20),
        what_is: toText(term.what_is).slice(0, 40) || undefined,
        why_now: toText(term.why_now).slice(0, 60) || undefined
      };
    })
    .filter((term) => term.term && term.gloss_ja && evidence.includes(term.term));
  const rawJapan = object.japan_availability && typeof object.japan_availability === "object"
    ? object.japan_availability as Record<string, unknown>
    : {};
  const japanAvailability = rawJapan.status === "verified"
    ? { status: "verified" as const, detail: toText(rawJapan.detail), evidence_refs: toStringArray(rawJapan.evidence_refs) }
    : { status: "not_in_evidence" as const, detail: "", evidence_refs: [] };
  return {
    topic_key: topicKey,
    claims,
    terms,
    japan_availability: japanAvailability,
    unresolved: toStringArray(object.unresolved)
  };
}

function evidenceText(evidence: RawArticle[]) {
  return evidence.map((article) => `${article.title}\n${article.rawContent || ""}\n${article.excerpt || ""}`).join("\n");
}

function normalizeClaim(value: unknown, index: number): FactLedgerClaim {
  const claim = value && typeof value === "object" ? value as Record<string, unknown> : {};
  let type = normalizeClaimType(claim.type);
  const sourceName = toText(claim.source_name);
  if (type === "source_analysis" && !sourceName) type = "unsupported";
  return {
    id: toText(claim.id) || `C${index + 1}`,
    type,
    text: toText(claim.text),
    evidence_refs: toStringArray(claim.evidence_refs),
    source_name: sourceName || undefined,
    entities: toStringArray(claim.entities),
    numbers: toStringArray(claim.numbers),
    quote_zh: toText(claim.quote_zh).slice(0, 30) || undefined
  };
}

function normalizeClaimType(value: unknown): ClaimType {
  return value === "verified_fact" || value === "source_analysis" || value === "unsupported" ? value : "unsupported";
}

async function generateGeminiJson(prompt: string, budget?: LlmCallBudget) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (!apiKey?.trim()) throw new Error("GEMINI_API_KEY is not set");
  if (budget) consumeLlmCall(budget);
  let response: Response;
  try {
    response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
  } catch (error) {
    throw new Error(`Gemini fact ledger network error: ${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`Gemini fact ledger API error: HTTP ${response.status} ${response.statusText} ${safePreview(await response.text())}`);
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
  if (!text.trim()) throw new Error("Gemini fact ledger API error: empty response text");
  return text;
}

async function generateDeepSeekJson(prompt: string, budget?: LlmCallBudget) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  if (!apiKey?.trim()) throw new Error("DEEPSEEK_API_KEY is not set");
  if (budget) consumeLlmCall(budget);
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (error) {
    throw new Error(`DeepSeek fact ledger network error: ${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`DeepSeek fact ledger API error: HTTP ${response.status} ${response.statusText} ${safePreview(await response.text())}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("DeepSeek fact ledger API error: empty response text");
  return text;
}

function parseJsonFromModelText(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) return JSON.parse(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  return JSON.parse(trimmed);
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function safePreview(value: string, maxLength = 500) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
