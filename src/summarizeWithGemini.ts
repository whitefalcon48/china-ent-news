import type { AiProvider, ArticleType, RawArticle, SummarizedArticle } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export async function summarizeArticle(article: RawArticle, provider = getAiProvider()): Promise<SummarizedArticle> {
  const text = await generateJson(provider, buildPrompt(article));
  return mergeInternalMetadata(normalizeSummary(parseJsonFromModelText(text)), article);
}

export async function summarizeWithGemini(article: RawArticle): Promise<SummarizedArticle> {
  return summarizeArticle(article, "gemini");
}

export async function testGeminiConnection() {
  return testAiConnection("gemini");
}

export async function testDeepSeekConnection() {
  return testAiConnection("deepseek");
}

export async function testAiConnection(provider: AiProvider) {
  const text = await generateJson(
    provider,
    `次のJSONだけを返してください。
{
  "ok": true,
  "message": "${provider} connection test succeeded"
}`
  );

  return parseJsonFromModelText(text) as {
    ok?: boolean;
    message?: string;
  };
}

export function getAiProvider(): AiProvider {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "deepseek") {
    return "deepseek";
  }
  return "gemini";
}

export function getGeminiEnvStatus() {
  return getProviderEnvStatus("gemini");
}

export function getProviderEnvStatus(provider: AiProvider) {
  if (provider === "deepseek") {
    return {
      provider,
      hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat"
    };
  }

  return {
    provider,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
  };
}

export function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = formatCause((error as Error & { cause?: unknown }).cause);
  return cause ? `${error.message} / cause: ${cause}` : error.message;
}

async function generateJson(provider: AiProvider, prompt: string) {
  if (provider === "deepseek") {
    return generateDeepSeekJson(prompt);
  }

  return generateGeminiJson(prompt);
}

async function generateGeminiJson(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY is not set. .envまたはGitHub SecretsにAPIキーを設定してください。");
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
          temperature: 0.1,
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
    throw new Error(`Gemini API error: HTTP ${response.status} ${response.statusText} ${safePreview(text)}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";

  if (!text.trim()) {
    throw new Error("Gemini API error: empty response text");
  }

  return text;
}

async function generateDeepSeekJson(prompt: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  if (!apiKey?.trim()) {
    throw new Error("DEEPSEEK_API_KEY is not set. .envまたはGitHub SecretsにAPIキーを設定してください。");
  }

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });
  } catch (error) {
    throw new Error(`DeepSeek network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API error: HTTP ${response.status} ${response.statusText} ${safePreview(text)}`);
  }

  const payload = (await response.json()) as DeepSeekResponse;
  const text = payload.choices?.[0]?.message?.content ?? "";

  if (!text.trim()) {
    throw new Error("DeepSeek API error: empty response text");
  }

  return text;
}

function buildPrompt(article: RawArticle) {
  return `あなたは中国エンタメの最新順フィードを作る編集補助AIです。

目的:
- 表に出す文章は、ナルエビちゃんニュース型の軽いニュースメモにする。
- 裏側では、元記事に書かれている内容だけを抽出し、記事タイプ、確度、ソース状況、topic_keyを整理する。
- 真偽判定や独自検証はしない。収集済み情報の抽出、分類、再構成だけを行う。

必ず次の順番で考える:
1. 抽出: 元記事に書かれている人物名、作品名、日付、数字、公式発表、報道内容、SNS反応、未確認表現、出典情報だけを取り出す。
2. 分類: article_type を判定する。分類は news_event / official_announcement / data_report / gossip_rumor / sns_trend / column_opinion / review / interview / static_page / unknown のいずれか。
3. 整理: 抽出結果だけを使い、軽く読める日本語ニュースメモにする。

禁止事項:
- 元記事にない情報を補わない。
- 業界一般論や背景説明で空欄を埋めない。
- 未確認情報を断定しない。
- 1ソースだけの場合、無理に複数ソース確認済みのように書かない。
- 出典にない人物評価、作品評価、興行評価を書かない。
- 中国人名や作品名を勝手に日本語読みへ変換しない。
- 原文の固有名詞はできるだけ原文表記も残す。
- コラム、論説、レビュー、インタビュー、静的ページをニュースイベントのように書かない。

出し分けルール:
- lead は2〜3行程度。何が起きたかが軽く分かる文章にする。
- what_happened は短く整理する。
- reaction_view は元記事内にSNS反応、読者反応、複数メディアでの見られ方がある場合だけ書く。なければ空文字。
- editor_note は注意点や見方の補助が必要な場合だけ書く。なければ空文字。
- SNS情報が元記事にない場合、has_sns_signal は false、reaction_view は空文字にする。
- 公式発表が記事内で確認できない場合、has_official_source は false にする。
- 1ソースのみの場合、has_multiple_sources は false にする。
- column_opinion / review / interview / static_page は skip_reason を必ず入れる。
- ゴシップでは「報じられた」「SNS上で話題になっている」など情報源に応じた表現にする。
- ゴシップや未確認情報がある場合、本人・事務所・公式側の反応有無と出典の弱さを editor_note または verification_status に反映する。
- 原文を翻訳調でなぞらず、日本語として自然に再構成する。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "title_ja": "",
  "lead": "",
  "what_happened": "",
  "reaction_view": "",
  "editor_note": "",
  "category": "",
  "confidence": "A/B/C/D",
  "source_count": 1,
  "source_list": [],
  "has_official_source": false,
  "has_multiple_sources": false,
  "has_sns_signal": false,
  "article_type": "",
  "skip_reason": "",
  "verification_status": "",
  "topic_key": "",
  "main_entities": {
    "people": [],
    "works": [],
    "organizations": []
  },
  "related_sources": [],
  "tags": []
}

入力記事:
- 原題: ${article.title}
- URL: ${article.url}
- 出典: ${article.sourceName}
- 出典カテゴリ: ${article.category}
- 初期確度: ${article.reliability}
- 事前article_type: ${article.articleType ?? "unknown"}
- 事前topic_key: ${article.topicKey ?? ""}
- 関連ソース候補: ${(article.relatedSources ?? [article.sourceName]).join(", ")}
- 公開日: ${article.publishedAt ?? "不明"}
- 抜粋: ${article.excerpt ?? "なし"}`;
}

function parseJsonFromModelText(text: string) {
  const jsonText = extractJsonText(text);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`AI JSON parse error: ${describeError(error)} / response preview: ${safePreview(text)}`);
  }
}

function extractJsonText(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeSummary(value: Partial<SummarizedArticle>): SummarizedArticle {
  return {
    title_ja: value.title_ja || "タイトル未設定",
    lead: value.lead || "",
    what_happened: value.what_happened || "",
    reaction_view: value.reaction_view || "",
    editor_note: value.editor_note || "",
    category: value.category || "未分類",
    confidence: value.confidence && ["A", "B", "C", "D"].includes(value.confidence) ? value.confidence : "C",
    source_count: typeof value.source_count === "number" ? value.source_count : ensureStringArray(value.source_list).length || 1,
    source_list: ensureStringArray(value.source_list),
    has_official_source: Boolean(value.has_official_source),
    has_multiple_sources: Boolean(value.has_multiple_sources),
    has_sns_signal: Boolean(value.has_sns_signal),
    article_type: normalizeArticleType(value.article_type),
    skip_reason: value.skip_reason || "",
    verification_status: value.verification_status || "",
    topic_key: value.topic_key || "",
    main_entities: {
      people: ensureStringArray(value.main_entities?.people),
      works: ensureStringArray(value.main_entities?.works),
      organizations: ensureStringArray(value.main_entities?.organizations)
    },
    related_sources: ensureStringArray(value.related_sources),
    tags: ensureStringArray(value.tags)
  };
}

function mergeInternalMetadata(summary: SummarizedArticle, article: RawArticle): SummarizedArticle {
  const relatedSources = article.relatedSources?.length ? article.relatedSources : [article.sourceName];
  return {
    ...summary,
    source_count: relatedSources.length,
    source_list: relatedSources,
    has_official_source: summary.has_official_source || article.reliability === "A",
    has_multiple_sources: relatedSources.length > 1,
    article_type: summary.article_type === "unknown" && article.articleType ? article.articleType : summary.article_type,
    topic_key: article.topicKey || summary.topic_key,
    main_entities: {
      people: summary.main_entities.people,
      works: summary.main_entities.works.length ? summary.main_entities.works : article.mainEntities?.works ?? [],
      organizations: summary.main_entities.organizations.length ? summary.main_entities.organizations : article.mainEntities?.organizations ?? []
    },
    related_sources: relatedSources
  };
}

function normalizeArticleType(value: unknown): ArticleType {
  const allowed: ArticleType[] = [
    "news_event",
    "official_announcement",
    "data_report",
    "gossip_rumor",
    "sns_trend",
    "column_opinion",
    "review",
    "interview",
    "static_page",
    "unknown"
  ];

  return typeof value === "string" && allowed.includes(value as ArticleType) ? (value as ArticleType) : "unknown";
}

function ensureStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function safePreview(value: string, maxLength = 500) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
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

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};
