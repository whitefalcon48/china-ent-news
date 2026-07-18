import fs from "node:fs/promises";
import path from "node:path";
import { reviseTopicFromSavedData } from "../summarizeWithGemini.js";
import type { FactLedger, ProcessedArticle, RawArticle, TopicCandidate } from "../types.js";

export async function reviseStoredArticle(directory: string, index: number, comment: string, reasonTag = "その他") {
  const articleFile = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!articleFile) throw new Error(`articles JSON not found: ${directory}`);
  const articlePath = path.join(directory, articleFile);
  const articles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  const article = articles[index - 1];
  if (!article?.topic) throw new Error(`topic data not found for article ${index}`);
  const ledger = await findLedger(directory, article.topic.topic_key);
  const evidence = rebuildEvidence(article);
  const revised = await reviseTopicFromSavedData(article.topic, evidence, ledger, comment, undefined, undefined, article.summary, reasonTag === "口調");
  articles[index - 1] = { ...article, summary: revised.summary, generationMeta: revised.meta };
  await fs.writeFile(articlePath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
  return articles[index - 1];
}

async function findLedger(directory: string, topicKey: string): Promise<FactLedger | null> {
  const ledgerFile = (await fs.readdir(directory)).filter((name) => /^fact_ledger_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!ledgerFile) return null;
  const stored = JSON.parse(await fs.readFile(path.join(directory, ledgerFile), "utf8")) as { ledgers?: Array<{ topic_key: string; ledger: FactLedger | null }> };
  return stored.ledgers?.find((item) => item.topic_key === topicKey)?.ledger || null;
}

function rebuildEvidence(article: ProcessedArticle): RawArticle[] {
  const topic = article.topic as TopicCandidate;
  if (!topic.evidence_articles.length) return [article.raw];
  return topic.evidence_articles.map((item, position) => position === 0 ? article.raw : ({
    title: item.title,
    url: item.url,
    sourceName: item.source_name,
    sourceUrl: item.url,
    category: article.raw.category,
    reliability: item.reliability,
    sourceType: item.source_type,
    publishedDate: item.published_date,
    freshnessLabel: item.freshness_label,
    articleType: item.article_type,
    excerpt: item.key_points.join("。")
  }));
}
