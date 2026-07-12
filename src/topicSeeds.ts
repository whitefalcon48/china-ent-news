import { createTopicKey, extractEventName, extractPersonName, extractPolicyKey, extractWorkName } from "./topicKey.js";
import { describeError, getAiProvider, getProviderEnvStatus } from "./summarizeWithGemini.js";
import type { AiProvider, MainEntities, RawArticle, TopicSeed, TopicSeedExtractionResult } from "./types.js";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_ARTICLES_PER_BATCH = 25;

type LlmSeedItem = {
  id?: number;
  topic_key?: string;
  event_sentence?: string;
  entities?: Partial<MainEntities & { events: string[] }>;
  search_queries?: string[];
  confidence?: number;
};

type LlmSeedResponse = {
  items?: LlmSeedItem[];
};

export async function extractTopicSeeds(articles: RawArticle[], provider: AiProvider = getAiProvider()): Promise<TopicSeedExtractionResult> {
  const fallbackSeeds = articles.map(toFallbackSeed);
  const env = getProviderEnvStatus(provider);
  const chunks = chunkArticles(articles, fallbackSeeds);

  if (!env.hasApiKey) {
    return {
      provider,
      attempted: false,
      succeeded: false,
      error: `${provider} API key is not set`,
      chunk_count: chunks.length,
      failed_chunk_count: chunks.length,
      seeds: fallbackSeeds
    };
  }

  const seeds: TopicSeed[] = [];
  const errors: string[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    try {
      const text = await generateTopicSeedJson(provider, buildTopicSeedPrompt(chunk.articles, chunk.fallbackSeeds));
      const parsed = parseJsonFromModelText(text) as LlmSeedResponse;
      seeds.push(...mergeLlmSeeds(chunk.articles, chunk.fallbackSeeds, parsed.items ?? []));
    } catch (error) {
      const message = describeError(error);
      errors.push(`chunk_${chunkIndex + 1}: ${message}`);
      seeds.push(...chunk.fallbackSeeds.map((seed) => ({ ...seed, error: message })));
    }
  }

  return {
    provider,
    attempted: chunks.length > 0,
    succeeded: chunks.length > 0 && errors.length === 0,
    error: errors.join(" | "),
    chunk_count: chunks.length,
    failed_chunk_count: errors.length,
    seeds
  };
}

function chunkArticles(articles: RawArticle[], fallbackSeeds: TopicSeed[]) {
  const chunks: Array<{ articles: RawArticle[]; fallbackSeeds: TopicSeed[] }> = [];
  for (let index = 0; index < articles.length; index += MAX_ARTICLES_PER_BATCH) {
    chunks.push({
      articles: articles.slice(index, index + MAX_ARTICLES_PER_BATCH),
      fallbackSeeds: fallbackSeeds.slice(index, index + MAX_ARTICLES_PER_BATCH)
    });
  }
  return chunks;
}

function toFallbackSeed(article: RawArticle): TopicSeed {
  const fallbackTopicKey = createTopicKey(article.title, article.excerpt ?? "");
  const text = `${article.title} ${article.excerpt ?? ""}`;
  return {
    article_url: article.url,
    article_title: article.title,
    fallback_topic_key: fallbackTopicKey,
    topic_key: fallbackTopicKey,
    event_sentence: buildFallbackEventSentence(article),
    entities: extractFallbackEntities(text),
    search_queries: buildFallbackQueries(article, fallbackTopicKey),
    confidence: 0.35,
    source: "regex_fallback"
  };
}

function buildFallbackEventSentence(article: RawArticle) {
  return `${article.sourceName}が「${article.title}」について報じた。`;
}

function extractFallbackEntities(text: string): MainEntities & { events: string[] } {
  const work = extractWorkName(text);
  const event = extractEventName(text);
  const policy = extractPolicyKey(text);
  const person = extractPersonName(text);
  return {
    people: person ? [person] : [],
    works: work ? [work] : [],
    organizations: policy && /国家|总局|电影局|广播电视/.test(policy) ? [policy] : [],
    events: event ? [event] : []
  };
}

function buildFallbackQueries(article: RawArticle, topicKey: string) {
  return [...new Set([topicKey, `${topicKey} ${article.sourceName}`, `${topicKey} 娱乐`].filter((query) => query.trim().length > 0))].slice(0, 3);
}

function mergeLlmSeeds(articles: RawArticle[], fallbackSeeds: TopicSeed[], items: LlmSeedItem[]) {
  const itemsById = new Map<number, LlmSeedItem>();
  for (const item of items) {
    if (typeof item.id === "number") {
      itemsById.set(item.id, item);
    }
  }

  return articles.map((article, index) => {
    const fallback = fallbackSeeds[index];
    const item = itemsById.get(index + 1);
    if (!item) {
      return fallback;
    }

    const topicKey = cleanTopicSeed(item.topic_key) || fallback.topic_key;
    return {
      ...fallback,
      topic_key: topicKey,
      event_sentence: cleanText(item.event_sentence ?? "") || fallback.event_sentence,
      entities: normalizeEntities(item.entities, fallback.entities),
      search_queries: normalizeQueries(item.search_queries, fallback.search_queries, topicKey),
      confidence: normalizeConfidence(item.confidence),
      source: "llm" as const
    };
  });
}

function buildTopicSeedPrompt(articles: RawArticle[], fallbackSeeds: TopicSeed[]) {
  const items = articles.map((article, index) => ({
    id: index + 1,
    title: article.title,
    excerpt: article.excerpt ?? "",
    source_name: article.sourceName,
    source_type: article.sourceType ?? (article.reliability === "A" ? "official" : "media_report"),
    article_type: article.articleType ?? "unknown",
    published_date: article.publishedDate ?? "",
    fallback_topic_key: fallbackSeeds[index]?.fallback_topic_key ?? ""
  }));

  return `You are extracting topic seeds for a China entertainment news pipeline.

Goal:
- Convert article title+excerpt into event-level topic seeds.
- The final output is topic-first, not article-summary-first.
- Same event across different article titles should receive exactly the same topic_key.

Rules:
- Output JSON only.
- For each input item, return one item with the same id.
- topic_key must be concise Chinese, event-level, and stable for clustering.
- Prefer: work title, event name, award/festival name, policy/filing event, or person+event.
- Do not use broken title fragments such as "达再合作", "演唱会高", or sentence tails.
- event_sentence should be Japanese, one sentence, factual, based only on input.
- search_queries must be 2-3 Chinese queries useful for finding related sources.
- Keep original Chinese names for works, people, events, and organizations.
- If uncertain, use fallback_topic_key.

Return shape:
{
  "items": [
    {
      "id": 1,
      "topic_key": "",
      "event_sentence": "",
      "entities": {
        "people": [],
        "works": [],
        "organizations": [],
        "events": []
      },
      "search_queries": [],
      "confidence": 0.0
    }
  ]
}

Input items:
${JSON.stringify(items, null, 2)}`;
}

async function generateTopicSeedJson(provider: AiProvider, prompt: string) {
  if (provider === "deepseek") {
    return generateDeepSeekJson(prompt);
  }
  return generateGeminiJson(prompt);
}

async function generateGeminiJson(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY is not set");
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
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 8192
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
    throw new Error(`Gemini topic seed network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Gemini topic seed API error: HTTP ${response.status} ${response.statusText} ${safePreview(await response.text())}`);
  }

  const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
  if (!text.trim()) {
    throw new Error("Gemini topic seed API error: empty response text");
  }
  return text;
}

async function generateDeepSeekJson(prompt: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  if (!apiKey?.trim()) {
    throw new Error("DEEPSEEK_API_KEY is not set");
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
        temperature: 0,
        max_tokens: 8000,
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
    throw new Error(`DeepSeek topic seed network error: ${describeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`DeepSeek topic seed API error: HTTP ${response.status} ${response.statusText} ${safePreview(await response.text())}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new Error("DeepSeek topic seed API error: empty response text");
  }
  return text;
}

function parseJsonFromModelText(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return JSON.parse(fenced[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(trimmed);
}

function normalizeEntities(value: LlmSeedItem["entities"], fallback: TopicSeed["entities"]): TopicSeed["entities"] {
  return {
    people: ensureStringArray(value?.people, fallback.people),
    works: ensureStringArray(value?.works, fallback.works),
    organizations: ensureStringArray(value?.organizations, fallback.organizations),
    events: ensureStringArray(value?.events, fallback.events)
  };
}

function normalizeQueries(value: unknown, fallback: string[], topicKey: string) {
  const queries = ensureStringArray(value, fallback).filter((query) => query.length >= 2);
  return [...new Set(queries.length ? queries : [topicKey, ...fallback])].slice(0, 3);
}

function ensureStringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const strings = value.map((item) => (typeof item === "string" ? cleanText(item) : "")).filter(Boolean);
  return strings.length ? strings : fallback;
}

function normalizeConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.6;
}

function cleanTopicSeed(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = cleanText(value).replace(/[。！？!?：:，,、；;]/g, " ").split(/\s+/)[0] ?? "";
  return cleaned.length >= 2 ? cleaned.slice(0, 40) : "";
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function safePreview(value: string, maxLength = 500) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
