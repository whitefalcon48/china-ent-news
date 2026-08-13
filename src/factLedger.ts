import fs from "node:fs/promises";
import path from "node:path";
import { consumeLlmCall, LlmCallBudgetExceededError, type LlmCallBudget } from "./llmCallBudget.js";
import { describeError, formatEvidenceForPrompt } from "./summarizeWithGemini.js";
import type { AiProvider, ClaimType, EvidenceRole, FactLedger, FactLedgerClaim, RawArticle, TopicCandidate } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const FACT_LEDGER_REQUEST_TIMEOUT_MS = 90_000;

export type FactLedgerExtractionResult = {
  succeeded: boolean;
  ledger?: FactLedger;
  error: string;
  anchor?: {
    topic_key: string;
    claims_total: number;
    anchor_unverified: number;
    dropped_explanations: Array<{ topic_key: string; term: string; reason: "anchor_not_found" | "anchor_missing" }>;
  };
};

export async function extractFactLedger(
  topic: TopicCandidate,
  evidence: RawArticle[],
  provider: AiProvider,
  budget?: LlmCallBudget,
  model?: string
): Promise<FactLedgerExtractionResult> {
  try {
    const prompt = buildFactLedgerPrompt(topic, evidence);
    let text: string;
    try {
      text = provider === "deepseek"
        ? await generateDeepSeekJson(prompt, budget, model)
        : await generateGeminiJson(prompt, budget, model);
    } catch (error) {
      // The manually supplied route can receive an empty response from Flash
      // even though the same facts are valid. Retry its fact-only request once
      // with the Pro model already proven by the daily generator. This retains
      // the exact ledger, claim-reference, and gate contract.
      if (provider === "deepseek" && model === "deepseek-v4-flash" && isEmptyDeepSeekResponse(error)) {
        text = await generateDeepSeekJson(prompt, budget, "deepseek-v4-pro");
      } else {
        throw error;
      }
    }
    const anchor = {
      topic_key: topic.topic_key,
      claims_total: 0,
      anchor_unverified: 0,
      dropped_explanations: [] as Array<{ topic_key: string; term: string; reason: "anchor_not_found" | "anchor_missing" }>
    };
    const ledger = normalizeFactLedger(parseJsonFromModelText(text), topic.topic_key, evidenceText(evidence), anchor, getEvidenceRoles(evidence));
    anchor.claims_total = ledger.claims.length;
    anchor.anchor_unverified = ledger.claims.filter((claim) => claim.anchor === false).length;
    return {
      succeeded: true,
      ledger,
      error: "",
      anchor
    };
  } catch (error) {
    const detail = describeError(error);
    return {
      succeeded: false,
      error: error instanceof LlmCallBudgetExceededError ? `llm_call_budget_exceeded: ${detail}` : detail
    };
  }
}

function isEmptyDeepSeekResponse(error: unknown) {
  return error instanceof Error && /DeepSeek fact ledger API error: empty response text after 2 attempts/u.test(error.message);
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

export function buildFactLedgerPrompt(topic: TopicCandidate, evidence: RawArticle[]) {
  return `あなたは中国エンタメニュースの事実整理AIです。1つのトピックと複数のevidenceから、後工程が日本語記事を書くための「事実台帳」をJSONで作ります。

最重要ルール: 後工程はこの台帳だけを使って記事を書き、台帳に無い情報は一切書けません。evidenceにある重要情報を漏らさず、evidenceに無い情報を混ぜないでください。あなた自身の知識・記憶にある背景情報（賞の仕組み、人物の経歴、過去の出来事など）は、evidenceに書かれていない限り、claimにもtermsにも一切入れてはいけません。

claimの分類（type）:
- verified_fact: evidenceに直接書かれている日付・数字・人物・組織・出来事。
- source_analysis: 元媒体による分析・見方・評価・将来予測。source_name（媒体名）を必ず入れる。
- unsupported: evidence中に現れるが根拠が確認できない情報（伝聞、真偽不明の噂など）。記事には使われない。

規則:
- claimのtextは必ず日本語1文で書く。中国語の文をそのまま写さない（人名・作品名などの固有名詞は原文表記のままでよい）。
- claimは1件1文。重要な順に最大20件。
- editorial_role は記事内での役割を表す。数字の基準・比較は key_numbers、補助金・政策は policy_support、映画館や現場の変化は venue_change、制作・配給・興行・雇用・周辺消費への波及は industry_spillover、人物の現在の状態は personal_condition、本人の工夫は working_method、制作現場の支援は production_support、日常の補助手段は daily_support、それ以外は other とする。
- 同じ内容の言い換えで20件を埋めない。evidenceにある異なる数字、政策、現場変化、波及先、人物の具体的な方法を優先する。
- entities（人物・作品・組織の固有名詞）とnumbers（数字・日付）は原文の表記のまま入れる。claimの文中に出てくる数字・日付・序数（第八届など）は必ずnumbersにも入れる。
- quote_zhには、そのclaimの根拠となるevidence原文の該当箇所を、原文の文字列のまま30字以内で抜き出して入れる。要約・言い換えをせず、原文にある文字列をそのまま写す。
 - evidence_refsには根拠のevidence番号（"E1"など）を必ず入れる。
 - claimのscopeは必ず "root_event" または "related_angle"。role=root_corroboration のEだけで支えられる出来事は root_event、role=related_angle のEだけで支えられる別角度は related_angle にする。
 - related_angle は中心出来事の裏付け・反応一般化・複数ソース化には絶対に使わない。root_event のclaimに related_angle のEを混ぜず、related_angle のclaimに root_corroboration のEを混ぜない。
- このトピックの中心にある制度・仕組み・業界用語について、evidenceが「それが何か」「なぜ問題・重要なのか」「どう機能するのか」を説明している場合、その説明を必ずclaimとして拾う。
- 制度・賞・仕組みの説明は、evidenceに書かれている範囲を1字も超えないこと。例: evidenceに「観客投票でノミネートを選ぶ」とだけ書かれている場合、「観客投票で受賞者が決まる」と書いてはいけない。選考方式・決定主体・段階は、evidenceの記述と厳密に一致させる。
- 日本での公開・配信・日本語字幕に関する情報がevidenceに明示されている場合のみ、japan_availabilityのstatusを "verified" にし、detailに内容、evidence_refsに根拠を入れる。evidenceに無ければ status は "not_in_evidence"、detailは空文字。推測で "verified" にしない。日本に関する言及が無いことは「日本未公開」を意味しない。
- terms には、このevidenceの本文に実際に登場する中国エンタメ用語のうち、日本の読者に説明が必要なものだけを入れる（最大8件）。evidenceに登場しない用語を入れない。一般的な用語例からの丸写しをしない。
  - gloss_ja: 短い日本語訳（20字以内）。
  - what_is: その用語が指す仕組み・制度の説明（40字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - why_now: 今回のニュースでその用語がなぜ重要かの説明（60字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - explain_quote_zh: what_is / why_now の根拠となるevidence原文の該当箇所を、原文の文字列のまま30字以内で。what_is と why_now が両方空なら空文字。
  - explain_evidence_refs: 説明の根拠のevidence番号。what_is と why_now が両方空なら空配列。
  - what_is / why_now を一般知識で補完しない。evidenceに根拠の文が無い場合は、どちらも空文字にする（説明が書けないことは問題ではない。後工程が「情報源に説明がない」ものとして扱う）。
- evidence間で数字・日付・事実が食い違う場合は unresolved に1行で記す。どちらかへ勝手に寄せない。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "topic_key": "<入力値をそのまま>",
  "claims": [{ "id": "C1", "type": "verified_fact", "scope": "root_event", "editorial_role": "other", "text": "", "evidence_refs": ["E1"], "source_name": "", "entities": [], "numbers": [], "quote_zh": "" }],
  "terms": [{ "term": "", "gloss_ja": "", "what_is": "", "why_now": "", "explain_quote_zh": "", "explain_evidence_refs": [] }],
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

export function normalizeFactLedger(
  value: unknown,
  topicKey: string,
  evidence: string,
  anchorDiagnostics?: { dropped_explanations: Array<{ topic_key: string; term: string; reason: "anchor_not_found" | "anchor_missing" }> },
  evidenceRoles: Record<string, EvidenceRole> = {}
): FactLedger {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawClaims = Array.isArray(object.claims) ? object.claims : [];
  const normalizedEvidence = normalizeAnchorText(evidence);
  const claims = rawClaims.slice(0, 20).map((item, index) => normalizeClaim(item, index, normalizedEvidence, evidenceRoles));
  const rawTerms = Array.isArray(object.terms) ? object.terms : [];
  const terms = rawTerms
    .slice(0, 8)
    .map((item) => {
      const term = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const normalized = {
        term: toText(term.term),
        gloss_ja: toText(term.gloss_ja).slice(0, 20),
        what_is: toText(term.what_is).slice(0, 40) || undefined,
        why_now: toText(term.why_now).slice(0, 60) || undefined,
        explain_quote_zh: toText(term.explain_quote_zh).slice(0, 30) || undefined,
        explain_evidence_refs: toStringArray(term.explain_evidence_refs)
      };
      if (normalized.what_is || normalized.why_now) {
        const quote = normalizeAnchorText(normalized.explain_quote_zh || "");
        if (!quote || !normalizedEvidence.includes(quote)) {
          anchorDiagnostics?.dropped_explanations.push({
            topic_key: topicKey,
            term: normalized.term,
            reason: quote ? "anchor_not_found" : "anchor_missing"
          });
          normalized.what_is = undefined;
          normalized.why_now = undefined;
          normalized.explain_quote_zh = undefined;
          normalized.explain_evidence_refs = [];
        }
      } else {
        normalized.explain_quote_zh = undefined;
        normalized.explain_evidence_refs = [];
      }
      return normalized;
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
    unresolved: toStringArray(object.unresolved),
    evidence_roles: evidenceRoles
  };
}

function evidenceText(evidence: RawArticle[]) {
  return evidence.map((article) => `${article.title}\n${article.rawContent || ""}\n${article.excerpt || ""}`).join("\n");
}

function normalizeClaim(value: unknown, index: number, normalizedEvidence: string, evidenceRoles: Record<string, EvidenceRole>): FactLedgerClaim {
  const claim = value && typeof value === "object" ? value as Record<string, unknown> : {};
  let type = normalizeClaimType(claim.type);
  const sourceName = toText(claim.source_name);
  if (type === "source_analysis" && !sourceName) type = "unsupported";
  const quote = toText(claim.quote_zh).slice(0, 30) || undefined;
  const normalizedQuote = normalizeAnchorText(quote || "");
  const evidenceRefs = toStringArray(claim.evidence_refs);
  const referencedRoles = evidenceRefs.map((ref) => evidenceRoles[ref]).filter((role): role is EvidenceRole => Boolean(role));
  // Scope is determined by the actual evidence roles, never by an LLM label.
  // This avoids a single root article being incorrectly marked as a related
  // angle and then failing the grounding gate despite having no such evidence.
  const inferredScope = referencedRoles.length > 0 && referencedRoles.every((role) => role === "related_angle")
    ? "related_angle"
    : "root_event";
  return {
    id: toText(claim.id) || `C${index + 1}`,
    type,
    text: toText(claim.text),
    evidence_refs: evidenceRefs,
    source_name: sourceName || undefined,
    entities: toStringArray(claim.entities),
    numbers: toStringArray(claim.numbers),
    quote_zh: quote,
    anchor: Boolean(normalizedQuote && normalizedEvidence.includes(normalizedQuote)),
    scope: inferredScope,
    editorial_role: normalizeEditorialRole(claim.editorial_role),
    ...(claim.angle_kind === "person_response" || claim.angle_kind === "career_retrospective" || claim.angle_kind === "audience_reaction" || claim.angle_kind === "work_context" || claim.angle_kind === "other" ? { angle_kind: claim.angle_kind } : {})
  };
}

function normalizeEditorialRole(value: unknown): NonNullable<FactLedgerClaim["editorial_role"]> {
  return value === "key_numbers" || value === "policy_support" || value === "venue_change" || value === "industry_spillover"
    || value === "personal_condition" || value === "working_method" || value === "production_support" || value === "daily_support"
    ? value
    : "other";
}

function getEvidenceRoles(evidence: RawArticle[]): Record<string, EvidenceRole> {
  return Object.fromEntries(evidence.map((article, index) => [`E${index + 1}`, article.evidenceRole ?? "root_corroboration"]));
}

export function normalizeAnchorText(value: string) {
  return value.replace(/[\s「」“”『』"'，。！？、；：,.!?;:（）()【】《》]/g, "");
}

function normalizeClaimType(value: unknown): ClaimType {
  return value === "verified_fact" || value === "source_analysis" || value === "unsupported" ? value : "unsupported";
}

async function generateGeminiJson(prompt: string, budget?: LlmCallBudget, modelOverride?: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
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

async function generateDeepSeekJson(prompt: string, budget?: LlmCallBudget, modelOverride?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = modelOverride || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  if (!apiKey?.trim()) throw new Error("DEEPSEEK_API_KEY is not set");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budget) consumeLlmCall(budget);
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FACT_LEDGER_REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          // A fact ledger is structured reference data, not article prose.
          // Keeping its response bounded avoids a long-running provider request
          // while still leaving room for claims, terms, and evidence refs.
          max_tokens: 3000,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("DeepSeek fact ledger request timeout");
      }
      throw new Error(`DeepSeek fact ledger network error: ${describeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`DeepSeek fact ledger API error: HTTP ${response.status} ${response.statusText} ${safePreview(await response.text())}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content ?? "";
    if (text.trim()) return text;
  }
  throw new Error("DeepSeek fact ledger API error: empty response text after 2 attempts");
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
