import fs from "node:fs/promises";
import path from "node:path";
import { consumeLlmCall, LlmCallBudgetExceededError, type LlmCallBudget } from "./llmCallBudget.js";
import { buildDeepSeekJsonRequest } from "./deepSeekRequest.js";
import { describeError, formatEvidenceForPrompt } from "./summarizeWithGemini.js";
import type { AiProvider, ClaimType, EvidenceRole, FactLedger, FactLedgerClaim, RawArticle, TopicCandidate } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const FACT_LEDGER_REQUEST_TIMEOUT_MS = 90_000;

export type FactLedgerExtractionResult = {
  succeeded: boolean;
  ledger?: FactLedger;
  error: string;
  diagnostic: FactLedgerExtractionDiagnostic;
  anchor?: {
    topic_key: string;
    claims_total: number;
    anchor_unverified: number;
    dropped_explanations: Array<{ topic_key: string; term: string; reason: "anchor_not_found" | "anchor_missing" }>;
  };
};

export type FactLedgerExtractionDiagnostic = {
  provider: AiProvider;
  model: string;
  attempts: number;
  stage: "generation" | "parse" | "complete";
  code: string;
  http_status?: number;
  finish_reason?: string;
  response_chars?: number;
  elapsed_ms: number;
};

export class FactLedgerExtractionError extends Error {
  readonly diagnostic: FactLedgerExtractionDiagnostic;

  constructor(result: FactLedgerExtractionResult) {
    super(`fact_ledger_extraction:${result.diagnostic.code}`);
    this.name = "FactLedgerExtractionError";
    this.diagnostic = result.diagnostic;
  }
}

export async function extractFactLedger(
  topic: TopicCandidate,
  evidence: RawArticle[],
  provider: AiProvider,
  budget?: LlmCallBudget,
  model?: string,
  retryInstruction = ""
): Promise<FactLedgerExtractionResult> {
  const startedAt = Date.now();
  const resolvedModel = model || (provider === "deepseek" ? process.env.DEEPSEEK_MODEL || "deepseek-v4-flash" : process.env.GEMINI_MODEL || "gemini-2.5-flash-lite");
  let lastError: unknown;
  let lastResponse: LedgerModelResponse | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts = attempt + 1;
    lastResponse = undefined;
    try {
      const prompt = `${buildFactLedgerPrompt(topic, evidence, retryInstruction)}${attempt > 0 ? `

再応答指示:
前回の応答は通信またはJSON構文の問題で利用できませんでした。事実の追加・削除はせず、指定schemaに従う完全なJSON objectだけを返してください。` : ""}`;
      const generate = async (request: string): Promise<LedgerModelResponse> => {
        try {
          return provider === "deepseek"
            ? await generateDeepSeekJson(request, budget, model)
            : await generateGeminiJson(request, budget, model);
        } catch (error) {
          // The manually supplied route can receive an empty response from Flash
          // even though the same facts are valid. Retry its fact-only request once
          // with the Pro model already proven by the daily generator. This retains
          // the exact ledger, claim-reference, and gate contract.
          if (provider === "deepseek" && model === "deepseek-v4-flash" && isEmptyDeepSeekResponse(error)) {
            return generateDeepSeekJson(request, budget, "deepseek-v4-pro");
          }
          throw error;
        }
      };
      const normalize = (text: string) => {
        const anchor = {
          topic_key: topic.topic_key,
          claims_total: 0,
          anchor_unverified: 0,
          dropped_explanations: [] as Array<{ topic_key: string; term: string; reason: "anchor_not_found" | "anchor_missing" }>
        };
        const ledger = normalizeFactLedger(parseJsonFromModelText(text), topic.topic_key, evidenceText(evidence), anchor, getEvidenceRoles(evidence));
        return { ledger, anchor };
      };
      lastResponse = await generate(prompt);
      if (lastResponse.finishReason?.toLowerCase() === "length") {
        throw new Error("fact ledger finish_reason length");
      }
      const { ledger: extractedLedger, anchor } = normalize(lastResponse.text);
      const ledger = ensureObservableRelatedClaims(extractedLedger, evidence);
      anchor.claims_total = ledger.claims.length;
      anchor.anchor_unverified = ledger.claims.filter((claim) => claim.anchor === false).length;
      return {
        succeeded: true,
        ledger,
        error: "",
        anchor,
        diagnostic: {
          provider,
          model: lastResponse.model,
          attempts,
          stage: "complete",
          code: "ok",
          finish_reason: lastResponse.finishReason,
          response_chars: lastResponse.text.length,
          elapsed_ms: Date.now() - startedAt
        }
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRetryableFactLedgerExtractionError(error)) continue;
      break;
    }
  }
  const detail = lastError instanceof SyntaxError ? "fact ledger JSON parse error" : describeError(lastError);
  const classified = classifyFactLedgerExtractionFailure(lastError);
  return {
    succeeded: false,
    error: lastError instanceof LlmCallBudgetExceededError ? `llm_call_budget_exceeded: ${detail}` : detail,
    diagnostic: {
      provider,
      model: lastResponse?.model ?? resolvedModel,
      attempts,
      stage: lastError instanceof SyntaxError ? "parse" : "generation",
      code: classified.code,
      http_status: classified.httpStatus,
      finish_reason: lastResponse?.finishReason,
      response_chars: lastResponse?.text.length,
      elapsed_ms: Date.now() - startedAt
    }
  };
}

export function isRetryableFactLedgerExtractionError(error: unknown) {
  if (error instanceof LlmCallBudgetExceededError) return false;
  if (error instanceof SyntaxError) return true;
  return error instanceof Error && /fact ledger (?:network error|request timeout|finish_reason length|API error: (?:empty response text|HTTP (?:408|429|5\d\d)))/u.test(error.message);
}

function classifyFactLedgerExtractionFailure(error: unknown) {
  if (error instanceof LlmCallBudgetExceededError) return { code: "budget_exceeded" };
  if (error instanceof SyntaxError) return { code: "invalid_json" };
  const message = error instanceof Error ? error.message : String(error);
  if (/finish_reason length/u.test(message)) return { code: "output_truncated" };
  if (/request timeout/u.test(message)) return { code: "timeout" };
  if (/network error/u.test(message)) return { code: "network_error" };
  if (/empty response/u.test(message)) return { code: "empty_response" };
  const status = Number(message.match(/API error: HTTP (\d{3})\b/u)?.[1] ?? 0);
  if (status) return { code: `http_${status}`, httpStatus: status };
  return { code: "generation_failed" };
}

type LedgerModelResponse = { text: string; finishReason?: string; model: string };

function isEmptyDeepSeekResponse(error: unknown) {
  return error instanceof Error && /DeepSeek fact ledger API error: empty response text/u.test(error.message);
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

export function buildFactLedgerPrompt(topic: TopicCandidate, evidence: RawArticle[], retryInstruction = "") {
  return `あなたは中国エンタメニュースの事実整理AIです。1つのトピックと複数のevidenceから、後工程が日本語記事を書くための「事実台帳」をJSONで作ります。

最重要ルール: 後工程はこの台帳だけを使って記事を書き、台帳に無い情報は一切書けません。evidenceにある重要情報を漏らさず、evidenceに無い情報を混ぜないでください。あなた自身の知識・記憶にある背景情報（賞の仕組み、人物の経歴、過去の出来事など）は、evidenceに書かれていない限り、claimにもtermsにも一切入れてはいけません。

claimの分類（type）:
- verified_fact: evidenceに直接書かれている日付・数字・人物・組織・出来事。
- source_analysis: 元媒体による分析・見方・評価・将来予測。source_name（媒体名）を必ず入れる。
- unsupported: evidence中に現れるが根拠が確認できない情報（伝聞、真偽不明の噂など）。記事には使われない。

規則:
- claimのtextは必ず日本語1文で書く。中国語の文をそのまま写さない（人名・作品名などの固有名詞は原文表記のままでよい）。
- claimは1件1文。root_eventは重要な順に最大20件、related_angleは検証済みEごとに最低1件・最大4件を追加できる（全体最大24件）。
- editorial_role は記事内での役割を表す。数字の基準・比較は key_numbers、補助金・政策は policy_support、映画館や現場の変化は venue_change、制作・配給・興行・雇用・周辺消費への波及は industry_spillover、人物の現在の状態は personal_condition、本人の工夫は working_method、制作現場の支援は production_support、日常の補助手段は daily_support、それ以外は other とする。
- 同じ内容の言い換えで20件を埋めない。evidenceにある異なる数字、政策、現場変化、波及先、人物の具体的な方法を優先する。
- entities（人物・作品・組織の固有名詞）とnumbers（数字・日付）は原文の表記のまま入れる。claimの文中に出てくる数字・日付・序数（第八届など）は必ずnumbersにも入れる。
- quote_zhには、そのclaimの根拠となるevidence原文の該当箇所を、原文の文字列のまま30字以内で抜き出して入れる。要約・言い換えをせず、原文にある文字列をそのまま写す。
 - evidence_refsには根拠のevidence番号（"E1"など）を必ず入れる。
- claimのscopeは必ず "root_event" または "related_angle"。role=root_corroboration のEだけで支えられる出来事は root_event、role=related_angle のEだけで支えられる別角度は related_angle にする。
- role=related_angle の各Eについて、本文から直接確認できる角度がある場合は、そのEを根拠に最低1件のclaimを作り、入力に表示された angle_kind（person_response / career_retrospective / audience_reaction / work_context / other）をそのまま入れる。
- angle_kind=audience_reaction で確認できるのが「熱搜入り」「話題ランキング入り」だけなら、その観測事実だけを書く。投稿コメントの内容、賛否、感情、反応件数を推測・一般化しない。
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
  "claims": [{ "id": "C1", "type": "verified_fact", "scope": "root_event", "angle_kind": "other", "editorial_role": "other", "text": "", "evidence_refs": ["E1"], "source_name": "", "entities": [], "numbers": [], "quote_zh": "" }],
  "terms": [{ "term": "", "gloss_ja": "", "what_is": "", "why_now": "", "explain_quote_zh": "", "explain_evidence_refs": [] }],
  "japan_availability": { "status": "not_in_evidence", "detail": "", "evidence_refs": [] },
  "unresolved": []
入力トピック:
- topic_key: ${topic.topic_key}
- event_sentence: ${topic.event_sentence}
- topic_type: ${topic.topic_type}

evidence一覧:
${formatEvidenceForPrompt(evidence)}${retryInstruction ? `

再抽出指示:
前回の台帳には次の不足がありました: ${retryInstruction}
evidenceに実在する異なる数字・政策・現場変化・産業波及を拾い直してください。同じ事実の言い換えで件数を増やさず、evidenceに無い事実は絶対に追加しないでください。` : ""}`;
}

/**
 * A search-ranking observation is both narrow and mechanically verifiable.
 * Preserve it even when the ledger model focuses on the richer biography in
 * the same document. This never invents sentiment or treats the angle as root
 * corroboration.
 */
export function ensureObservableRelatedClaims(ledger: FactLedger, evidence: RawArticle[]): FactLedger {
  const claims = [...ledger.claims];
  for (const [index, article] of evidence.entries()) {
    if (article.evidenceRole !== "related_angle" || article.angleKind !== "audience_reaction") continue;
    const ref = `E${index + 1}`;
    if (claims.some((claim) => claim.scope === "related_angle" && claim.angle_kind === "audience_reaction" && claim.evidence_refs.includes(ref))) continue;
    const content = `${article.title}\n${article.rawContent || article.excerpt || ""}`;
    const observation = extractHotSearchObservation(content);
    if (!observation) continue;
    claims.push({
      id: nextClaimId(claims),
      type: "verified_fact",
      text: `${observation.date ? `${observation.date}、` : ""}「#${observation.topic}#」が熱搜入りしたと${article.sourceName}が報じた。`,
      evidence_refs: [ref],
      source_name: article.sourceName,
      entities: observation.topic.includes("李雪健") ? ["李雪健"] : [],
      numbers: observation.date ? [observation.date] : [],
      quote_zh: observation.quote,
      anchor: true,
      scope: "related_angle",
      angle_kind: "audience_reaction",
      editorial_role: "other"
    });
  }
  return { ...ledger, claims };
}

function extractHotSearchObservation(content: string) {
  const match = content.match(/(?:(\d{1,2}月\d{1,2}日)[，,、\s]*)?#([^#\r\n]{2,60})#[^。\r\n]{0,16}?(?:冲上|登上|进入)热搜/u);
  if (!match) return null;
  return { date: match[1] || "", topic: match[2]!.trim(), quote: match[0]!.slice(0, 30) };
}

function nextClaimId(claims: FactLedgerClaim[]) {
  const used = new Set(claims.map((claim) => claim.id));
  let number = claims.length + 1;
  while (used.has(`C${number}`)) number += 1;
  return `C${number}`;
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
  const normalizedClaims = rawClaims.slice(0, 30).map((item, index) => normalizeClaim(item, index, normalizedEvidence, evidenceRoles));
  const claims = [
    ...normalizedClaims.filter((claim) => claim.scope !== "related_angle").slice(0, 20),
    ...normalizedClaims.filter((claim) => claim.scope === "related_angle").slice(0, 4)
  ];
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
  const rawEvidenceRefs = toStringArray(claim.evidence_refs);
  const referencedRoles = rawEvidenceRefs.map((ref) => evidenceRoles[ref]).filter((role): role is EvidenceRole => Boolean(role));
  // Scope is determined by the actual evidence roles, never by an LLM label.
  // This avoids a single root article being incorrectly marked as a related
  // angle and then failing the grounding gate despite having no such evidence.
  const inferredScope = referencedRoles.length > 0 && referencedRoles.every((role) => role === "related_angle")
    ? "related_angle"
    : "root_event";
  // A model may cite a root article and a related-angle repost for the same
  // biographical fact. The related document must never strengthen the root,
  // so retain only refs from the inferred scope before the claim gate runs.
  const evidenceRefs = rawEvidenceRefs.filter((ref) => evidenceRoles[ref] === inferredScope.replace("root_event", "root_corroboration"));
  return {
    id: toText(claim.id) || `C${index + 1}`,
    type,
    text: toText(claim.text),
    evidence_refs: evidenceRefs.length ? evidenceRefs : rawEvidenceRefs,
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
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
  if (!text.trim()) throw new Error("Gemini fact ledger API error: empty response text");
  return { text, finishReason: payload.candidates?.[0]?.finishReason, model };
}

async function generateDeepSeekJson(prompt: string, budget?: LlmCallBudget, modelOverride?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = modelOverride || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  if (!apiKey?.trim()) throw new Error("DEEPSEEK_API_KEY is not set");
  if (budget) consumeLlmCall(budget);
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FACT_LEDGER_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(buildDeepSeekJsonRequest(model, prompt, 8000, 0))
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
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("DeepSeek fact ledger API error: empty response text");
  return { text, finishReason: payload.choices?.[0]?.finish_reason, model };
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
