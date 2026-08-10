import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type GenerationStatus = "succeeded" | "no_candidate" | "generation_failed";

export type GenerationStatusDecision = {
  status: GenerationStatus;
  shouldFail: boolean;
};

export function decideGenerationStatus(status: GenerationStatus): GenerationStatusDecision {
  return {
    status,
    // An empty normal candidate pool is an expected reviewable outcome. A
    // non-empty selected pool that produced nothing is an operational failure.
    shouldFail: status === "generation_failed"
  };
}

export async function readGenerationStatus(tracePath: string): Promise<GenerationStatusDecision> {
  const parsed = JSON.parse(await fs.readFile(tracePath, "utf8")) as { generation_status?: { status?: unknown } };
  const status = parsed.generation_status?.status;
  if (status !== "succeeded" && status !== "no_candidate" && status !== "generation_failed") {
    throw new Error(`generation_status is missing or invalid: ${tracePath}`);
  }
  return decideGenerationStatus(status);
}

export async function findGenerationTrace(outputDir: string, date?: string) {
  const names = await fs.readdir(outputDir);
  const matching = names
    .filter((name) => date ? name === `selection_trace_${date}.json` : /^selection_trace_\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  const selected = matching.at(-1);
  if (!selected) {
    throw new Error(`selection trace not found${date ? ` for ${date}` : ""}: ${outputDir}`);
  }
  return path.join(outputDir, selected);
}

async function main() {
  const outputDir = path.resolve(process.env.PIPELINE_OUTPUT_DIR || "output");
  const runDate = process.env.RUN_DATE;
  const archiveDate = process.env.ARCHIVE_DATE;
  const generationStatusDate = process.env.GENERATION_STATUS_DATE;
  const configuredDates = [runDate, archiveDate, generationStatusDate].filter((value): value is string => Boolean(value));
  if (new Set(configuredDates).size > 1) {
    throw new Error(`RUN_DATE, ARCHIVE_DATE, and GENERATION_STATUS_DATE must match: ${configuredDates.join(", ")}`);
  }
  const date = generationStatusDate || archiveDate || runDate;
  const tracePath = await findGenerationTrace(outputDir, date);
  const decision = await readGenerationStatus(tracePath);
  console.log(`generation status: ${decision.status} (${tracePath})`);
  if (decision.shouldFail) {
    console.error("generation_failed: daily data and review state were archived, but selected candidates produced no publishable output.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`generation status check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
