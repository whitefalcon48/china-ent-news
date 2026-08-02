import fs from "node:fs/promises";
import path from "node:path";
import { candidateReviewPath, createCandidateReviewFromTopicFile } from "./candidateReviewState.js";

async function main() {
  const date = process.argv[2] || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日付は YYYY-MM-DD で指定してください");
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const topicPath = path.join(dataDir, date, `topic_candidates_${date}.json`);
  const outputPath = candidateReviewPath(dataDir, date);
  try {
    await fs.access(outputPath);
    console.log(`候補レビューはすでにあります: ${outputPath}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state = await createCandidateReviewFromTopicFile(topicPath, outputPath, date);
  console.log(`候補レビューを作成しました: ${outputPath} (${state.candidates.length}件)`);
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

main().catch((error) => {
  console.error(`候補レビュー作成に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
