import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decideGenerationStatus, readGenerationStatus } from "./checkGenerationStatus.js";
import { buildSelectionTrace } from "./selectionTrace.js";
import type { RawArticle } from "./types.js";

const selectedWithoutOutput = buildSelectionTrace({
  provider: "deepseek",
  candidatePool: [],
  deepseekInput: [{} as RawArticle],
  processed: [],
  droppedReasons: new Map(),
  selectionReasons: new Map(),
  outputCountInstruction: null
});
assert.equal(selectedWithoutOutput.generation_status.status, "generation_failed");
assert.equal(selectedWithoutOutput.generation_status.selected_count, 1);
assert.equal(decideGenerationStatus(selectedWithoutOutput.generation_status.status).shouldFail, true);

const noInput = buildSelectionTrace({
  provider: "deepseek",
  candidatePool: [],
  deepseekInput: [],
  processed: [],
  droppedReasons: new Map(),
  selectionReasons: new Map(),
  outputCountInstruction: null
});
assert.equal(noInput.generation_status.status, "no_candidate");
assert.equal(decideGenerationStatus(noInput.generation_status.status).shouldFail, false);

const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-news-generation-status-"));
const fixturePath = path.join(fixtureDirectory, "selection_trace_2026-08-09.json");
await fs.writeFile(fixturePath, `${JSON.stringify(selectedWithoutOutput)}\n`, "utf8");
assert.deepEqual(await readGenerationStatus(fixturePath), { status: "generation_failed", shouldFail: true });
await fs.writeFile(fixturePath, `${JSON.stringify(noInput)}\n`, "utf8");
assert.deepEqual(await readGenerationStatus(fixturePath), { status: "no_candidate", shouldFail: false });
await fs.rm(fixtureDirectory, { recursive: true, force: true });

console.log("generation status tests passed.");
