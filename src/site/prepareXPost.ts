import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { articleIdFor, readPublicationReview, type PublicationReviewState } from "../review/publication.js";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const date = process.env.POST_DATE || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("POST_DATE is required (YYYY-MM-DD)");
  const result = await prepareXPost(dataDir, date, shanghaiTimestamp());
  console.log(`X post attempt prepared: ${date} ${result.articleIds.length}件`);
}

/**
 * Commit this marker before calling X. If the API accepts a post but the later
 * receipt commit fails, the next Action stops for an explicit operator retry
 * instead of sending a duplicate automatically.
 */
export async function prepareXPost(dataRoot: string, date: string, attemptedAt: string) {
  const directory = path.join(dataRoot, date);
  const review = await readPublicationReview(directory);
  if (!review) throw new Error(`${date}: review.json がありません`);
  const articleIds: string[] = [];
  for (const article of review.articles) {
    const publication = article.publication;
    if (!publication?.x_pending_at || publication.x_posted_at || publication.x_post_attempt_id) continue;
    const articleId = articleIdFor(review, article);
    article.publication = {
      ...publication,
      x_post_attempt_id: `x-${randomUUID()}`,
      x_post_attempted_at: attemptedAt
    };
    articleIds.push(articleId);
  }
  if (articleIds.length) await writeReview(directory, review);
  return { articleIds };
}

function shanghaiTimestamp() {
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
