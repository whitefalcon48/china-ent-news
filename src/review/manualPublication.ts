import fs from "node:fs/promises";
import path from "node:path";

export type ManualIntakeRecord = Record<string, unknown> & {
  comment_id?: string;
  status?: string;
  published_date?: string;
  published_url?: string;
};

export function manualIntakeRoot(dataDir: string) {
  return path.join(dataDir, "manual-intake");
}

export function manualIntakeDirectory(dataDir: string, commentId: string) {
  return path.join(manualIntakeRoot(dataDir), commentId);
}

export function manualArticleSlug(commentId: string) {
  if (!/^\d+$/.test(commentId)) throw new Error(`Invalid manual intake comment id: ${commentId}`);
  return `m-${commentId}`;
}

export function captureManualPublication(commentId: string, siteUrl: string, getPublishedDate: () => string) {
  const publishedDate = getPublishedDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) throw new Error(`Invalid manual publication date: ${publishedDate}`);
  const baseUrl = siteUrl.replace(/\/$/, "");
  return {
    publishedDate,
    publishedUrl: `${baseUrl}/t/${publishedDate}/${manualArticleSlug(commentId)}/`
  };
}

export async function readManualIntakeRecord(directory: string): Promise<ManualIntakeRecord> {
  const file = path.join(directory, "intake-state.json");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid manual intake state: ${file}`);
  return parsed as ManualIntakeRecord;
}

export async function writeManualIntakeRecord(directory: string, record: ManualIntakeRecord) {
  await fs.writeFile(path.join(directory, "intake-state.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function findManualReviewPath(dataDir: string, issueNumber: number, requestedCommentId?: string) {
  const root = manualIntakeRoot(dataDir);
  const ids = requestedCommentId ? [requestedCommentId] : (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(right) - Number(left));
  for (const commentId of ids) {
    const directory = manualIntakeDirectory(dataDir, commentId);
    const reviewPath = path.join(directory, "review.json");
    try {
      const review = JSON.parse(await fs.readFile(reviewPath, "utf8")) as { issue_number?: unknown };
      if (!issueNumber || review.issue_number === issueNumber) return { reviewPath, commentId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`manual review.json not found for issue #${issueNumber}`);
}

export async function markManualIntakePublished(dataDir: string, commentId: string, publishedDate: string, publishedUrl: string) {
  const directory = manualIntakeDirectory(dataDir, commentId);
  const record = await readManualIntakeRecord(directory);
  await writeManualIntakeRecord(directory, {
    ...record,
    comment_id: commentId,
    status: "published",
    published_date: publishedDate,
    published_url: publishedUrl
  });
}
