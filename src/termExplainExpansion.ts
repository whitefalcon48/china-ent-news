import * as cheerio from "cheerio";
import { searchSerperOrganic, type SerperOrganicItem } from "./expandSources.js";
import { normalizeAnchorText } from "./factLedger.js";
import { hasLlmBudgetRemaining, type LlmCallBudget } from "./llmCallBudget.js";
import type { AiProvider, FactLedger, RawArticle, TermExpansionTrace, TopicCandidate } from "./types.js";

const TERM_PATTERN = /(奖|总局|电影局|协会|文联|章程|办法|条例|规定|名单|公示)/;
const OFFICIAL_DOMAIN_SUFFIXES = ["gov.cn", "org.cn", "cflac.org.cn", "chinafilm.gov.cn"];
const MAX_TOPICS_PER_RUN = 2;
const MAX_DOCUMENT_CHARS = 5000;

export const TERM_EXPLAIN_PROMPT = `あなたは中国エンタメ制度の事実整理AIです。与えられた公式文書の本文だけを根拠に、指定された用語の説明をJSONで返します。

規則:
- 文書に書かれていることだけを使う。あなた自身の知識で補完しない。
- what_is: その用語が指す仕組み・制度の説明（40字以内の日本語）。文書に説明が無ければ空文字。
- why_now: 空文字のままでよい（今回のニュースとの関係はここでは書かない）。
- explain_quote_zh: what_is の根拠となる文書原文の該当箇所を、原文の文字列のまま30字以内で抜き出す。要約・言い換えをしない。what_is が空なら空文字。
- 選考方式・決定主体・段階の説明は、文書の記述と厳密に一致させる。段階が複数ある場合（例: 投票で候補を選び、評委が受賞者を決める）は、一段階だけを全体の仕組みのように書かない。
- 必ずJSONだけを返す。

返すJSON:
{ "what_is": "", "why_now": "", "explain_quote_zh": "" }`;

type ExpansionGenerator = (provider: AiProvider, prompt: string, budget?: LlmCallBudget, model?: string) => Promise<string>;

export type TermExpansionSession = {
  attemptedTopics: Set<string>;
  trace: TermExpansionTrace;
};

type ExpansionDependencies = {
  search?: (query: string) => Promise<SerperOrganicItem[]>;
  fetchDocument?: (url: string) => Promise<string>;
  generate: ExpansionGenerator;
};

export function createTermExpansionSession(): TermExpansionSession {
  const enabled = process.env.TERM_EXPLAIN_EXPANSION !== "false";
  return {
    attemptedTopics: new Set<string>(),
    trace: { enabled, attempted: [], succeeded: [], failed: [] }
  };
}

export async function expandTermExplanation(
  topic: TopicCandidate,
  evidence: RawArticle[],
  ledger: FactLedger,
  provider: AiProvider,
  model: string,
  budget: LlmCallBudget | undefined,
  session: TermExpansionSession,
  dependencies: ExpansionDependencies
): Promise<void> {
  if (!session.trace.enabled) return;
  const target = ledger.terms.find((term) => TERM_PATTERN.test(term.term) && !term.what_is?.trim());
  if (!target) return;
  if (session.attemptedTopics.has(topic.topic_key)) return;
  if (session.attemptedTopics.size >= MAX_TOPICS_PER_RUN) {
    session.trace.failed.push({ topic_key: topic.topic_key, term: target.term, reason: "topic_limit_reached" });
    return;
  }

  const query = `${target.term} 章程 评选办法`;
  session.attemptedTopics.add(topic.topic_key);
  session.trace.attempted.push({ topic_key: topic.topic_key, term: target.term, query });

  if (!process.env.SERPER_API_KEY?.trim() && !dependencies.search) {
    fail(session, topic, target.term, "serper_not_configured");
    return;
  }
  if (budget && !hasLlmBudgetRemaining(budget)) {
    fail(session, topic, target.term, "llm_call_budget_exhausted");
    return;
  }

  try {
    const results = await (dependencies.search ?? searchSerperOrganic)(query);
    const result = results.find((item) => item.link && isAllowedOfficialUrl(item.link));
    if (!result?.link) {
      fail(session, topic, target.term, "official_domain_not_found");
      return;
    }
    const documentText = await (dependencies.fetchDocument ?? fetchOfficialDocument)(result.link);
    if (!documentText.trim()) {
      fail(session, topic, target.term, "official_document_empty");
      return;
    }
    const prompt = `${TERM_EXPLAIN_PROMPT}\n\n対象 term: ${target.term}\n\n取得文書本文:\n${documentText.slice(0, MAX_DOCUMENT_CHARS)}`;
    const response = await dependencies.generate(provider, prompt, budget, model);
    const parsed = parseExpansionResponse(response);
    const quote = parsed.explain_quote_zh.trim().slice(0, 30);
    if (!parsed.what_is.trim() || !quote) {
      fail(session, topic, target.term, "explanation_or_anchor_missing");
      return;
    }
    if (!normalizeAnchorText(documentText).includes(normalizeAnchorText(quote))) {
      fail(session, topic, target.term, "anchor_not_found");
      return;
    }
    const evidenceRef = `E${evidence.length + 1}`;
    target.what_is = parsed.what_is.trim().slice(0, 40);
    target.why_now = parsed.why_now.trim();
    target.explain_quote_zh = quote;
    target.explain_evidence_refs = [evidenceRef];
    evidence.push({
      title: result.title?.trim() || target.term,
      url: result.link,
      sourceName: new URL(result.link).hostname,
      sourceUrl: result.link,
      category: "用語一次資料",
      reliability: "A",
      declaredSourceType: "official",
      rawContent: documentText,
      rawContentLength: documentText.length
    });
    session.trace.succeeded.push({ topic_key: topic.topic_key, term: target.term, url: result.link });
  } catch (error) {
    fail(session, topic, target.term, `expansion_failed:${describeError(error)}`);
  }
}

export function isAllowedOfficialUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return OFFICIAL_DOMAIN_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

async function fetchOfficialDocument(url: string) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsPhase3/0.1)" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function parseExpansionResponse(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const json = fenced ?? value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    what_is: typeof parsed.what_is === "string" ? parsed.what_is : "",
    why_now: typeof parsed.why_now === "string" ? parsed.why_now : "",
    explain_quote_zh: typeof parsed.explain_quote_zh === "string" ? parsed.explain_quote_zh : ""
  };
}

function fail(session: TermExpansionSession, topic: TopicCandidate, term: string, reason: string) {
  session.trace.failed.push({ topic_key: topic.topic_key, term, reason });
}

function describeError(error: unknown) {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}
