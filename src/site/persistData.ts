import fs from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output");
const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
const requestedDate = process.env.ARCHIVE_DATE;

const names = await fs.readdir(outputDir);
const articlesFiles = names.filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const selectedArticles = requestedDate ? `articles_${requestedDate}.json` : articlesFiles.at(-1);
if (!selectedArticles || !names.includes(selectedArticles)) {
  throw new Error(`永続化する articles JSON がありません${requestedDate ? `: ${requestedDate}` : ""}`);
}

const date = selectedArticles.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
if (!date) throw new Error(`articles JSON の日付を解釈できません: ${selectedArticles}`);
const destination = path.join(dataDir, date);
await fs.mkdir(destination, { recursive: true });

const existingArticles = path.join(destination, selectedArticles);
if (process.env.ALLOW_DATA_OVERWRITE !== "true") {
  try {
    await fs.access(existingArticles);
    console.log(`data persist: ${date} は保存済みのため上書きしません`);
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `date=${date}\n`, "utf8");
    process.exit(0);
  } catch {
    // 初回だけ保存する。過去日の連番URLを再生成で変えないためのガード。
  }
}

const targets = names.filter((name) =>
  name === selectedArticles ||
  name === `${date}-deepseek.md` ||
  name === `${date}-gemini.md` ||
  name === `selection_trace_${date}.json` ||
  name === `topic_candidates_${date}.json` ||
  name === `fact_ledger_${date}.json` ||
  name === `review_${date}.json`
);
for (const name of targets) {
  const destinationName = name === `review_${date}.json` ? "review.json" : name;
  await fs.copyFile(path.join(outputDir, name), path.join(destination, destinationName));
}

console.log(`data persist: ${date} / ${targets.length} files -> ${destination}`);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `date=${date}\n`, "utf8");
