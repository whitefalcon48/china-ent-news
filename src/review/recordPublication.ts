import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  articleIdFor,
  currentVersionFor,
  readPublicationReview,
  readRevisionFile,
  slugFor,
  type PublicationReviewState
} from "./publication.js";

type PublicationBatchArticle = {
  article_id: string;
  index: number;
  slug: string;
  published_version: number;
  first_publication: boolean;
};

type PublicationBatch = {
  date: string;
  recorded_at: string;
  articles: PublicationBatchArticle[];
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const outputDir = path.resolve(process.env.SITE_OUTPUT_DIR || "output");
  const date = process.env.POST_DATE || process.env.PUBLICATION_DATE || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("POST_DATE or PUBLICATION_DATE is required (YYYY-MM-DD)");
  const result = await recordPublication(dataDir, outputDir, date, publicationTimestamp());
  console.log(`publication record: ${date} ${result.batch.articles.length}件 ${result.batchPath}`);
}

export async function recordPublication(dataRoot: string, outputRoot: string, dateValue: string, recordedAt: string) {
  const directory = path.join(dataRoot, dateValue);
  const review = await readPublicationReview(directory);
  if (!review) throw new Error(`${dateValue}: review.json がありません`);
  const revisions = await readRevisionFile(directory);
  const batchArticles: PublicationBatchArticle[] = [];
  let changed = false;

  for (const article of review.articles) {
    if (article.status !== "approved") continue;
    const articleId = articleIdFor(review, article);
    const currentVersion = currentVersionFor(article, revisions, articleId);
    const alreadyPublished = article.publication?.published_at && article.publication.published_version === currentVersion;
    if (alreadyPublished) continue;
    const slug = slugFor(review, article);
    const firstPublication = !article.publication?.published_at;
    article.publication = {
      ...article.publication,
      slug,
      published_at: article.publication?.published_at || recordedAt,
      published_version: currentVersion,
      ...(firstPublication ? { x_pending_at: article.publication?.x_pending_at || recordedAt } : { updated_at: recordedAt })
    };
    batchArticles.push({ article_id: articleId, index: article.index, slug, published_version: currentVersion, first_publication: firstPublication });
    changed = true;
  }

  if (changed) await writeReview(directory, review);
  const batch: PublicationBatch = { date: dateValue, recorded_at: recordedAt, articles: batchArticles };
  await fs.mkdir(outputRoot, { recursive: true });
  const batchPath = path.join(outputRoot, `publication_batch_${dateValue}.json`);
  await fs.writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
  return { changed, batch, batchPath };
}

function publicationTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value || "00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

async function writeReview(directory: string, review: PublicationReviewState) {
  await fs.writeFile(path.join(directory, "review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
}
