import fs from "node:fs/promises";
import path from "node:path";
import type { RawArticle, TopicCandidate } from "./types.js";

export type CompareFixture = {
  date: string;
  topics: Array<{ topic: TopicCandidate; evidence: RawArticle[] }>;
};

export async function writeCompareFixture(items: Array<{ topic?: TopicCandidate; evidence: RawArticle[] }>, date = today()) {
  if (process.env.WRITE_COMPARE_FIXTURE !== "true") return "";
  const fixture: CompareFixture = {
    date,
    topics: items.flatMap((item) => item.topic ? [{ topic: item.topic, evidence: item.evidence }] : [])
  };
  const outputPath = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output", `compare_fixture_${date}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return outputPath;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
