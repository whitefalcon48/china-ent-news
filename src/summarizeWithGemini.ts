import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiProvider,
  ArticleType,
  ContextValue,
  FeedBadge,
  FreshnessLabel,
  LevelLabel,
  RawArticle,
  SnsHeat,
  SourceTypeLabel,
  PublishPriority,
  SummarizedArticle
} from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export const OUTPUT_COUNT_INSTRUCTION = "Output every candidate item that is worth publishing; do not force a 3-5 item cap. Add publish_priority (high/medium/low) and publish_reason to every output article.";

let editorialCharacterCache: string | undefined;

async function loadEditorialCharacter() {
  if (editorialCharacterCache !== undefined) {
    return editorialCharacterCache;
  }

  try {
    editorialCharacterCache = await fs.readFile(path.resolve("docs", "editorial-character.md"), "utf8");
  } catch {
    editorialCharacterCache = "Read local editorial-character policy if available. Focus on China-local entertainment context, Japan visibility gaps, cautious handling of PR, rumors, and SNS heat.";
  }

  return editorialCharacterCache;
}

export async function summarizeArticle(article: RawArticle, provider = getAiProvider()): Promise<SummarizedArticle> {
  const text = await generateJson(provider, await buildPrompt(article));
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

async function buildPrompt(article: RawArticle) {
  const editorialCharacter = await loadEditorialCharacter();

  return `あなたは中国エンタメの最新順フィードを作る編集補助AIです。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy for title angle, hitokoto, Japan-context notes, PR WATCH handling, HOT SEARCH handling, and cautious rumor wording.

Output count instruction for this generation run:
${OUTPUT_COUNT_INSTRUCTION}

publish_priority rules:
- publish_priority: high means strongly aligned with this project and should be prioritized.
- publish_priority: medium means useful reference value and publishable.
- publish_priority: low means collectable information but low priority for regular distribution.
- publish_reason must briefly explain the priority, such as industry lineup visibility, drama/streaming production trend, weak China-entertainment context, or official source with production-environment significance.


目的:
- 表に出す文章は、ナルエビちゃんニュース型の軽いニュースメモにする。
- 1本あたりの日本語本文量は通常400〜700字程度を目安にする。公式発表系は300〜500字でもよい。ゴシップ・騒動系は500〜800字程度まで許容する。
- 裏側では、元記事に書かれている内容だけを抽出し、記事タイプ、確度、ソース状況、topic_keyを整理する。
- 真偽判定や独自検証はしない。収集済み情報の抽出、分類、再構成だけを行う。

編集キャラクター:
- このサイトは中国語記事の翻訳・要約サイトではない。
- 中国現地で評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋める。
- 架空の中立ニュースキャスターではなく、運営者の分身としての編集者キャラで書く。
- 何が起きたかだけでなく、なぜそれが面白いのかを拾う。
- 日本語圏では見えにくい文脈がある場合だけ、短く補足する。
- 公式発表は確度Aでも中立とは限らない。官製PR、文化輸出、対外発信、国策文脈は一歩引いて見る。
- Weibo热搜などのSNS話題は現地温度の観測メモとして扱い、真偽判定を目的にしない。
- 中国特有のファン文化や用語（飯圏、流量、控評、番位、CP、营销号、塌房など）は必要に応じて短く補足する。

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

タイトル生成ルール:
- 事実だけの固い見出しにしない。
- 「なぜ面白いか」「どこが引っかかるか」が少し見えるようにする。
- 試算・予測は「試算も」「見込み」「可能性」などを付ける。
- 感嘆符や断定調で煽らない。
- ゴシップ系は断定しない。
- 作品名・人名は原文表記を基本にし、勝手に日本語読みへ変換しない。
- 中国本土作品は簡体字を基本表記にする。初出で必要なら日本語仮訳を添える。

出し分けルール:
- lead は2〜3行程度。何が起きたかが軽く分かる文章にする。
- what_happened は150〜250字程度で、出来事・数字・日付・関係者を整理する。
- reaction_view は元記事内にSNS反応、読者反応、複数メディアでの見られ方、話題性、業界的意味がある場合に150〜250字程度で書く。根拠がなければ空文字。
- editor_comment は「ひとこと」として表示する読者向けの主観コメント。内部メモではなく、編集者キャラの短い見方を書く。
- japan_context_note は「日本語圏では見えにくいポイント」として表示する。中国では高評価・高興行、日本語圏では紹介されにくい文脈、ファン文化、方言・地域文化、国家宣伝・文化輸出、日本公開・字幕情報などがある場合だけ書く。なければ空文字。
- 各記事は lead とは別に、what_happened と why_it_matters / reaction_view / editor_comment のいずれかを含め、最低2つの本文セクションを埋める。ただし根拠がない反応は作らない。
- SNS情報が元記事にない場合、has_sns_signal は false、reaction_view は空文字にする。
- 公式発表が記事内で確認できない場合、has_official_source は false にする。
- 1ソースのみの場合、has_multiple_sources は false にする。
- column_opinion / review / interview / static_page は skip_reason を必ず入れる。
- badge は NEWS / HOT SEARCH / WATCH / OFFICIAL / DATA / PR WATCH のいずれか。
- source_type は official / media_report / sns / data / pr_like / rumor / mixed のいずれか。
- HOT SEARCHは通常ニュースと同じフィードに混ぜるが、断定しない。公式発表や大手報道がない場合、confidence は C または D にする。
- PR WATCHは官製PRや文化交流記事をそのまま流さず、何を外向きに見せたい記事かをひとことで補足する。
- ゴシップでは「報じられた」「SNS上で話題になっている」など情報源に応じた表現にする。
- ゴシップや未確認情報がある場合、本人・事務所・公式側の反応有無と出典の弱さを editor_comment または verification_status に反映する。
- 原文を翻訳調でなぞらず、日本語として自然に再構成する。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "title_ja": "",
  "badge": "NEWS",
  "lead": "",
  "what_happened": "",
  "why_it_matters": "",
  "reaction_view": "",
  "editor_comment": "",
  "japan_context_note": "",
  "category": "",
  "confidence": "A/B/C/D",
  "source_type": "media_report",
  "published_date": "",
  "event_date": "",
  "freshness_label": "recent",
  "newsworthiness_score": 0,
  "japan_visibility": "unknown",
  "japan_gap": "unknown",
  "context_value": "medium",
  "sns_heat": "none",
  "source_count": 1,
  "source_list": [{"name": "", "url": ""}],
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
  "related_sources": [{"name": "", "url": ""}],
  "tags": [],
  "publish_priority": "medium",
  "publish_reason": ""
}

入力記事:
- 原題: ${article.title}
- URL: ${article.url}
- 出典: ${article.sourceName}
- 出典カテゴリ: ${article.category}
- 初期確度: ${article.reliability}
- 事前badge: ${article.badge ?? "NEWS"}
- 事前source_type: ${article.sourceType ?? "media_report"}
- 事前published_date: ${article.publishedDate ?? ""}
- 事前event_date: ${article.eventDate ?? ""}
- 事前freshness_label: ${article.freshnessLabel ?? "unknown"}
- 事前newsworthiness_score: ${article.newsworthinessScore ?? 0}
- 事前japan_visibility: ${article.japanVisibility ?? "unknown"}
- 事前japan_gap: ${article.japanGap ?? "unknown"}
- 事前context_value: ${article.contextValue ?? "low"}
- 事前sns_heat: ${article.snsHeat ?? "none"}
- 事前article_type: ${article.articleType ?? "unknown"}
- 事前topic_key: ${article.topicKey ?? ""}
- 関連ソース候補: ${(article.relatedSources ?? [{ name: article.sourceName, url: article.url }]).map((source) => `${source.name} ${source.url ?? ""}`).join(", ")}
- 公開日: ${article.publishedAt ?? "不明"}
- rawContentLength: ${article.rawContentLength ?? 0}
- 抜粋: ${article.excerpt ?? "なし"}
- 元本文: ${article.rawContent || article.excerpt || "なし"}`;
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
    badge: normalizeBadge(value.badge),
    lead: value.lead || "",
    what_happened: value.what_happened || "",
    reaction_view: value.reaction_view || "",
    why_it_matters: value.why_it_matters || "",
    editor_comment: value.editor_comment || "",
    japan_context_note: value.japan_context_note || "",
    category: value.category || "未分類",
    confidence: value.confidence && ["A", "B", "C", "D"].includes(value.confidence) ? value.confidence : "C",
    source_type: normalizeSourceType(value.source_type),
    published_date: value.published_date || "",
    event_date: value.event_date || "",
    freshness_label: normalizeFreshnessLabel(value.freshness_label),
    newsworthiness_score: typeof value.newsworthiness_score === "number" ? value.newsworthiness_score : 0,
    japan_visibility: normalizeLevelLabel(value.japan_visibility),
    japan_gap: normalizeLevelLabel(value.japan_gap),
    context_value: normalizeContextValue(value.context_value),
    sns_heat: normalizeSnsHeat(value.sns_heat),
    source_count: typeof value.source_count === "number" ? value.source_count : ensureSourceRefs(value.source_list).length || 1,
    source_list: ensureSourceRefs(value.source_list),
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
    related_sources: ensureSourceRefs(value.related_sources),
    tags: ensureStringArray(value.tags),
    publish_priority: normalizePublishPriority(value.publish_priority),
    publish_reason: typeof value.publish_reason === "string" ? value.publish_reason : ""
  };
}

function mergeInternalMetadata(summary: SummarizedArticle, article: RawArticle): SummarizedArticle {
  const relatedSources = article.relatedSources?.length ? article.relatedSources : [{ name: article.sourceName, url: article.url }];
  return {
    ...summary,
    badge: summary.badge === "NEWS" && article.badge && article.badge !== "NEWS" ? article.badge : summary.badge || article.badge || "NEWS",
    source_type:
      summary.source_type === "media_report" && article.sourceType && article.sourceType !== "media_report"
        ? article.sourceType
        : summary.source_type || article.sourceType || "media_report",
    published_date: summary.published_date || article.publishedDate || "",
    event_date: summary.event_date || article.eventDate || "",
    freshness_label: summary.freshness_label || article.freshnessLabel || "unknown",
    newsworthiness_score: summary.newsworthiness_score || article.newsworthinessScore || 0,
    japan_visibility: summary.japan_visibility === "unknown" ? article.japanVisibility ?? "unknown" : summary.japan_visibility,
    japan_gap: summary.japan_gap === "unknown" ? article.japanGap ?? "unknown" : summary.japan_gap,
    context_value: summary.context_value === "low" && article.contextValue ? article.contextValue : summary.context_value,
    sns_heat: summary.sns_heat === "none" && article.snsHeat ? article.snsHeat : summary.sns_heat,
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

function normalizePublishPriority(value: unknown): PublishPriority {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
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

function normalizeBadge(value: unknown): FeedBadge {
  const allowed: FeedBadge[] = ["NEWS", "HOT SEARCH", "WATCH", "OFFICIAL", "DATA", "PR WATCH"];
  return typeof value === "string" && allowed.includes(value as FeedBadge) ? (value as FeedBadge) : "NEWS";
}

function normalizeSourceType(value: unknown): SourceTypeLabel {
  const allowed: SourceTypeLabel[] = ["official", "media_report", "sns", "data", "pr_like", "rumor", "mixed"];
  return typeof value === "string" && allowed.includes(value as SourceTypeLabel) ? (value as SourceTypeLabel) : "media_report";
}

function normalizeFreshnessLabel(value: unknown): FreshnessLabel {
  const allowed: FreshnessLabel[] = ["today", "yesterday", "recent", "stale", "old", "unknown", "background"];
  return typeof value === "string" && allowed.includes(value as FreshnessLabel) ? (value as FreshnessLabel) : "unknown";
}

function normalizeLevelLabel(value: unknown): LevelLabel {
  const allowed: LevelLabel[] = ["high", "medium", "low", "unknown"];
  return typeof value === "string" && allowed.includes(value as LevelLabel) ? (value as LevelLabel) : "unknown";
}

function normalizeContextValue(value: unknown): ContextValue {
  const allowed: ContextValue[] = ["high", "medium", "low"];
  return typeof value === "string" && allowed.includes(value as ContextValue) ? (value as ContextValue) : "low";
}

function normalizeSnsHeat(value: unknown): SnsHeat {
  const allowed: SnsHeat[] = ["high", "medium", "low", "none"];
  return typeof value === "string" && allowed.includes(value as SnsHeat) ? (value as SnsHeat) : "none";
}

function ensureStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function ensureSourceRefs(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return { name: item };
      }
      if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
        const url = "url" in item && typeof item.url === "string" ? item.url : undefined;
        return { name: item.name, url };
      }
      return null;
    })
    .filter((item): item is { name: string; url?: string } => Boolean(item?.name));
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
