import type { RawArticle, SummarizedArticle } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export async function summarizeWithGemini(article: RawArticle): Promise<SummarizedArticle> {
  const text = await generateGeminiJson(buildPrompt(article));
  return normalizeSummary(JSON.parse(stripCodeFence(text)));
}

export async function testGeminiConnection() {
  const text = await generateGeminiJson(`次のJSONだけを返してください。
{
  "ok": true,
  "message": "Gemini connection test succeeded"
}`);

  return JSON.parse(stripCodeFence(text)) as {
    ok?: boolean;
    message?: string;
  };
}

export function getGeminiEnvStatus() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  return {
    hasApiKey: Boolean(apiKey?.trim()),
    model
  };
}

export function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = formatCause((error as Error & { cause?: unknown }).cause);
  return cause ? `${error.message} / cause: ${cause}` : error.message;
}

async function generateGeminiJson(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY is not set. .envにAPIキーを設定してください。");
  }

  let response: Response;
  try {
    response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    });
  } catch (error) {
    throw new Error(`Gemini network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: HTTP ${response.status} ${response.statusText} ${text}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";

  if (!text.trim()) {
    throw new Error("Gemini API error: empty response text");
  }

  return text;
}

function buildPrompt(article: RawArticle) {
  return `あなたは中国エンタメニュースを日本語で整理する編集補助AIです。

目的:
- 元記事の情報を、事実・報道内容・SNS反応・未確認情報に分けて整理する。
- 真偽判定はしない。収集済み情報の分類と読みやすい日本語化だけを行う。

重要な編集方針:
- 元記事にない情報を補わない。
- 未確認情報を断定しない。
- SNS反応を事実のように書かない。
- ゴシップでは本人・事務所・公式発表の有無が記事内にある場合だけ書く。ない場合は「記事内では確認できない」とする。
- 出典が弱い場合は confidence を下げる。
- 原文を翻訳調でなぞらず、日本語で自然に再構成する。
- 人物を貶める表現、容姿・病気・家族・未成年絡みの煽りは避ける。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "title_ja": "",
  "summary_bullets": ["", "", ""],
  "category": "",
  "confidence": "A/B/C/D",
  "confirmed_facts": [],
  "reported_claims": [],
  "sns_reactions": [],
  "unverified_points": [],
  "multiple_viewpoints": [],
  "body_ja": "",
  "source_notes": "",
  "tags": []
}

入力記事:
- 原題: ${article.title}
- URL: ${article.url}
- 出典: ${article.sourceName}
- 出典カテゴリ: ${article.category}
- 初期確度: ${article.reliability}
- 公開日: ${article.publishedAt ?? "不明"}
- 抜粋: ${article.excerpt ?? "なし"}`;
}

function stripCodeFence(value: string) {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeSummary(value: Partial<SummarizedArticle>): SummarizedArticle {
  return {
    title_ja: value.title_ja || "タイトル未設定",
    summary_bullets: ensureStringArray(value.summary_bullets),
    category: value.category || "未分類",
    confidence: value.confidence && ["A", "B", "C", "D"].includes(value.confidence) ? value.confidence : "C",
    confirmed_facts: ensureStringArray(value.confirmed_facts),
    reported_claims: ensureStringArray(value.reported_claims),
    sns_reactions: ensureStringArray(value.sns_reactions),
    unverified_points: ensureStringArray(value.unverified_points),
    multiple_viewpoints: ensureStringArray(value.multiple_viewpoints),
    body_ja: value.body_ja || "",
    source_notes: value.source_notes || "",
    tags: ensureStringArray(value.tags)
  };
}

function ensureStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function formatCause(cause: unknown): string {
  if (!cause) {
    return "";
  }

  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${cause.message} (${code})` : cause.message;
  }

  if (typeof cause === "object") {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  return String(cause);
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};
