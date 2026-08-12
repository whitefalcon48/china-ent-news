import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkManualReviewIssue } from "./intake/linkManualReviewIssue.js";
import { classifyManualIntakeError, preserveManualIntakeRootEvidence, requireManualGenerationLedger, runManualIntakeCli } from "./intake/processManualIntake.js";
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
    "fact_ledger_api_http_500"
  );
  assert.equal(
    classifyManualIntakeError(new Error("generation:ledger_not_used:ledger_extraction_failed: DeepSeek fact ledger request timeout"), "generating"),
    "fact_ledger_timeout"
  );
  assert.equal(classifyManualIntakeError(new Error("claim_check_gate: number_not_in_ledger: secret text"), "generating"), "claim_check_failed");
  assert.equal(classifyManualIntakeError(new Error("DeepSeek API: secret response body"), "generating"), "summary_generation_failed");
  assert.equal(classifyManualIntakeError(new Error("disk write failed"), "persisting"), "intake_persistence_failed");

  const rootTopic = {
    topic_key: "manual-topic",
    title_hint: "root",
    event_sentence: "root event",
    search_queries: [],
    seed_source: "regex_fallback" as const,
    seed_confidence: 1,
    topic_type: "policy" as const,
    freshness_label: "recent" as const,
    published_date_range: { earliest: "2026-08-10", latest: "2026-08-10" },
    source_count: 1,
    source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [],
    main_entities: { people: [], works: [], organizations: [], events: [] },
    signals: { has_official_source: false, has_media_context: true, has_data_signal: false, has_hot_search_signal: false, has_multiple_sources: false },
    newsworthiness_score: 1,
    japan_gap: "unknown" as const,
    context_value: "low" as const,
    publish_priority: "low" as const,
    selection_reason: "root",
    caution_note: "",
    related_evidence_articles: []
  };
  const researchedTopic = {
    ...rootTopic,
    freshness_label: "today" as const,
    published_date_range: { earliest: "2026-08-12", latest: "2026-08-12" },
    related_evidence_articles: [{
      title: "unrelated result",
      url: "https://example.com/unrelated",
      source_name: "Example",
      source_type: "media_report" as const,
      published_date: "2020-01-01",
      freshness_label: "recent" as const,
      article_type: "unknown" as const,
      reliability: "C" as const,
      key_points: ["unrelated"],
      angle_kind: "other" as const
    }]
  };
  const manualTopic = preserveManualIntakeRootEvidence(rootTopic, researchedTopic);
  assert.deepEqual(manualTopic.related_evidence_articles, [], "manual intake must not mix an unrelated research angle into the user-supplied article");
  assert.deepEqual(manualTopic.published_date_range, rootTopic.published_date_range, "manual intake keeps the supplied article date");

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
