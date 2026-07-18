import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewFeedback } from "../types.js";

const inputPath = path.resolve(process.env.REVIEW_FEEDBACK_PATH || "data/review-feedback.jsonl");

async function main() {
  let text = "";
  try {
    text = await fs.readFile(inputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ReviewFeedback);
  console.log(`# Review feedback report\n\nTotal: ${records.length}\n`);
  printGroup("Reason tags", records, (record) => record.reason_tag || "その他");
  printGroup("Categories", records, (record) => record.category || "未設定");
  printGroup("Seed confidence", records, (record) => confidenceBand(record.seed_confidence));
}

function printGroup(title: string, records: ReviewFeedback[], keyFor: (record: ReviewFeedback) => string) {
  const counts = new Map<string, number>();
  records.forEach((record) => counts.set(keyFor(record), (counts.get(keyFor(record)) || 0) + 1));
  console.log(`## ${title}`);
  if (!counts.size) console.log("- なし");
  else [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([key, count]) => console.log(`- ${key}: ${count}`));
  console.log("");
}

function confidenceBand(value: number) {
  if (value >= 0.8) return "0.8-1.0";
  if (value >= 0.5) return "0.5-0.79";
  return "0-0.49";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
