import assert from "node:assert/strict";
import { getRunDate } from "./index.js";

// A supplied date is an archive identity, not a display hint. It must be
// retained exactly, including for historical GitHub Actions reruns.
assert.equal(getRunDate("2026-08-07"), "2026-08-07");
assert.equal(getRunDate("2024-02-29"), "2024-02-29");

for (const invalid of ["2026-8-07", "2026/08/07", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-08-00", " 2026-08-07", "2026-08-07 "]) {
  assert.throws(() => getRunDate(invalid), /RUN_DATE must be a real calendar date/);
}

// With no supplied date, only Shanghai's calendar date is used.
assert.equal(getRunDate("", new Date("2026-08-09T16:30:00.000Z")), "2026-08-10");

console.log("run date tests passed.");
