import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  captureManualPublication,
  markManualIntakePublished,
  readManualIntakeRecord
} from "./review/manualPublication.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-publication-boundary-"));
try {
  const directory = path.join(root, "manual-intake", "42");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "intake-state.json"), `${JSON.stringify({
    version: 1,
    comment_id: "42",
    status: "review_ready"
  }, null, 2)}\n`, "utf8");

  let clockCalls = 0;
  const publication = captureManualPublication("42", "https://example.test/", () => {
    clockCalls += 1;
    return clockCalls === 1 ? "2026-08-11" : "2026-08-12";
  });
  assert.equal(clockCalls, 1, "publication date must be captured exactly once at a date boundary");
  assert.deepEqual(publication, {
    publishedDate: "2026-08-11",
    publishedUrl: "https://example.test/t/2026-08-11/m-42/"
  });

  await markManualIntakePublished(root, "42", publication.publishedDate, publication.publishedUrl);
  const state = await readManualIntakeRecord(directory);
  assert.equal(state.status, "published");
  assert.equal(state.published_date, publication.publishedDate, "state must use the captured date");
  assert.equal(state.published_url, publication.publishedUrl, "published URL must use the captured date");
  console.log("manual publication boundary: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
