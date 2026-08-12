import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkManualReviewIssue } from "./intake/linkManualReviewIssue.js";
import { classifyManualIntakeError, requireManualGenerationLedger, runManualIntakeCli } from "./intake/processManualIntake.js";
import { writeManualIntakeState } from "./intake/intakeState.js";
import { findLedger } from "./review/reviseArticle.js";
import { writeReviewState } from "./review/reviewState.js";
import type { FactLedger, TopicGenerationMeta } from "./types.js";

async function main() {
  const ledger: FactLedger = {
    topic_key: "topic",
    claims: [],
    terms: [],
    japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
    unresolved: []
  };
  const validMeta: TopicGenerationMeta = {
    topic_key: "topic",
    ledger_used: true,
    ledger_fallback_reason: "",
    ledger,
    claim_check: { topic_key: "topic", violations: [], gated_violation_count: 0, action: "none" }
  };
  assert.equal(requireManualGenerationLedger(validMeta), ledger);
  assert.throws(() => requireManualGenerationLedger({ ...validMeta, ledger: undefined }), /ledger_missing/);
  assert.throws(() => requireManualGenerationLedger({ ...validMeta, claim_check: undefined }), /claim_check_missing/);
  assert.throws(() => requireManualGenerationLedger({ ...validMeta, ledger_used: false, ledger_fallback_reason: "failed" }), /ledger_not_used/);
  assert.throws(() => requireManualGenerationLedger({ ...validMeta, claim_check: { ...validMeta.claim_check!, gated_violation_count: 1 } }), /claim_check_gated/);
  assert.equal(classifyManualIntakeError(new Error("fetch:http_500")), "fetch:http_500");
  assert.equal(classifyManualIntakeError(new Error("DeepSeek API: secret response body")), "manual_intake_processing_failed");
  assert.equal(
    classifyManualIntakeError(new Error("generation:ledger_not_used:ledger_extraction_failed: DeepSeek fact ledger API error: HTTP 500 secret response body"), "generating"),
    "fact_ledger_api_error"
  );
  assert.equal(
    classifyManualIntakeError(new Error("generation:ledger_not_used:ledger_extraction_failed: DeepSeek fact ledger request timeout"), "generating"),
    "fact_ledger_timeout"
  );
  assert.equal(classifyManualIntakeError(new Error("claim_check_gate: number_not_in_ledger: secret text"), "generating"), "claim_check_failed");
  assert.equal(classifyManualIntakeError(new Error("DeepSeek API: secret response body"), "generating"), "summary_generation_failed");
  assert.equal(classifyManualIntakeError(new Error("disk write failed"), "persisting"), "intake_persistence_failed");

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "manual-intake-cli-"));
  const outputPath = path.join(temporary, "github-output.txt");
  try {
    const success = await runManualIntakeCli({
      MANUAL_COMMENT_ID: "321",
      MANUAL_COMMENT_BODY: "https://example.com/news\nurgent",
      MANUAL_COMMENT_AUTHOR: "owner",
      MANUAL_COMMENT_ASSOCIATION: "OWNER",
      SITE_DATA_DIR: "data",
      AI_PROVIDER: "deepseek",
      GITHUB_OUTPUT: outputPath
    }, {
      processIntake: async (options) => ({
        ok: true,
        idempotent: false,
        commentId: String(options.comment.id),
        directory: "data/manual-intake/321",
        reviewBodyPath: "data/manual-intake/321/review-issue.md",
        reviewIssueNumber: 0
      })
    });
    assert.equal(success.ok, true);
    const output = await fs.readFile(outputPath, "utf8");
    assert.match(output, /^comment_id=321$/m);
    assert.match(output, /^result=review_ready$/m);
    assert.match(output, /^review_body_path=data\/manual-intake\/321\/review-issue\.md$/m);
    assert.match(output, /^review_issue_number=0$/m);

    const failureOutput = path.join(temporary, "failure-output.txt");
    const failure = await runManualIntakeCli({ MANUAL_COMMENT_ID: "", GITHUB_OUTPUT: failureOutput });
    assert.equal(failure.ok, false);
    assert.match(await fs.readFile(failureOutput, "utf8"), /^result=failed$/m);

    const thrownOutput = path.join(temporary, "thrown-output.txt");
    const thrown = await runManualIntakeCli({ MANUAL_COMMENT_ID: "322", GITHUB_OUTPUT: thrownOutput }, {
      processIntake: async () => { throw new Error("unexpected\nerror"); }
    });
    assert.equal(thrown.ok, false);
    assert.match(await fs.readFile(thrownOutput, "utf8"), /^error=manual_intake_processing_failed$/m);

    const intakeState = {
      version: 1 as const,
      comment_id: "321",
      source_url: "https://example.com/news",
      note: "",
      status: "review_ready" as const,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z"
    };
    await writeManualIntakeState(intakeState, temporary);
    const intakeDirectory = path.join(temporary, "manual-intake", "321");
    await writeReviewState(path.join(intakeDirectory, "review.json"), { date: "2026-08-11", status: "pending", issue_number: 0, articles: [] });
    const linked = await linkManualReviewIssue({
      commentId: "321",
      issueNumber: 99,
      issueUrl: "https://github.com/example/repo/issues/99",
      dataRoot: temporary
    });
    assert.equal(linked.ok, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(intakeDirectory, "review.json"), "utf8")).issue_number, 99);
    assert.equal(JSON.parse(await fs.readFile(path.join(intakeDirectory, "intake-state.json"), "utf8")).review_issue_number, 99);
    const linkedAgain = await linkManualReviewIssue({ commentId: "321", issueNumber: 99, issueUrl: "https://github.com/example/repo/issues/99", dataRoot: temporary });
    assert.deepEqual(linkedAgain, { ok: true, idempotent: true, commentId: "321", issueNumber: 99 });

    await fs.writeFile(path.join(intakeDirectory, "fact_ledger_2026-08-11.json"), `${JSON.stringify({
      date: "2026-08-11",
      generated_at: "2026-08-11T00:00:00.000Z",
      ledgers: [{ topic_key: "topic", ledger, fallback_reason: "" }]
    }, null, 2)}\n`, "utf8");
    assert.deepEqual(await findLedger(intakeDirectory, "topic"), ledger);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("manual intake CLI tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
