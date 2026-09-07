import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildQualityEvaluationManifest,
  writeQualityEvaluationManifest
} from "./quality/buildEvaluationManifest.js";

type ExpectedInventory = {
  dates: Array<{ date: string; article_count: number }>;
  articles: Array<{ date: string; index: number; article_id: string | null; topic_key: string; title: string }>;
};

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(sourceRoot, "..");
const dataRoot = path.join(repositoryRoot, "data");
const expected = JSON.parse(await fs.readFile(path.join(repositoryRoot, "tests/fixtures/stage-c/baseline-inventory.json"), "utf8")) as ExpectedInventory;
const beforeHash = await hashBaselineInputs(dataRoot, expected.dates.map((item) => item.date));
const manifest = await buildQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot });
const afterHash = await hashBaselineInputs(dataRoot, expected.dates.map((item) => item.date));

assert.equal(beforeHash, afterHash, "比較manifestの読込みはinput dataを変更しない");
assert.equal(manifest.version, 1);
assert.equal(manifest.totals.dates, 7);
assert.equal(manifest.totals.articles, 11);
assert.equal(manifest.totals.zero_article_days, 1);
assert.equal(manifest.totals.ledger_generated, 8);
assert.equal(manifest.totals.ledger_fallback, 3);
assert.equal(manifest.totals.known_claim_evidence_bindings, 1, "工程Bの明示C/E mapだけを既知扱いする");
assert.equal(manifest.totals.unresolved_claim_evidence_pairs > 0, true, "旧候補配列からC/Eを推測しない");
assert.equal(manifest.totals.comparable_articles, 0, "生成時RawArticle配列がない旧記事を新基準passにしない");
assert.match(manifest.repository_sha ?? "", /^[a-f0-9]{40}$/u);
assert.deepEqual(
  manifest.dates.map((item) => ({ date: item.date, article_count: item.article_count })),
  expected.dates
);
assert.deepEqual(
  manifest.articles.map((item) => ({ date: item.date, index: item.index, article_id: item.article_id, topic_key: item.topic_key, title: item.title })),
  expected.articles
);
assert.equal(manifest.dates.find((item) => item.date === "2026-09-01")?.zero_article_day, true);
assert.equal(manifest.dates.flatMap((item) => item.input_files).filter((file) => file.exists).every((file) => /^[a-f0-9]{40}$/u.test(file.git_blob_sha ?? "")), true);
const firstArticlesFile = manifest.dates[0]!.input_files.find((file) => file.kind === "articles")!;
const committedBlob = (await execFileAsync("git", ["rev-parse", `HEAD:${firstArticlesFile.path}`], { cwd: repositoryRoot, windowsHide: true })).stdout.trim();
assert.equal(firstArticlesFile.git_blob_sha, committedBlob, "CRLF等のGit filter適用後blob IDを記録する");

const septemberSecond = manifest.articles.find((item) => item.date === "2026-09-02" && item.index === 2)!;
assert.equal(septemberSecond.versions.draft.version_number, 1);
assert.equal(septemberSecond.versions.current.version_number, 4);
assert.notEqual(septemberSecond.versions.draft.summary_hash, septemberSecond.versions.current.summary_hash, "9/2の初稿と現行版を混同しない");
assert.equal(septemberSecond.versions.published.available, false);

const septemberSixth = manifest.articles.find((item) => item.date === "2026-09-06" && item.index === 1)!;
assert.equal(septemberSixth.versions.draft.version_number, 1);
assert.equal(septemberSixth.versions.current.version_number, 2);
assert.equal(septemberSixth.versions.published.version_number, 2);
assert.notEqual(septemberSixth.versions.draft.summary_hash, septemberSixth.versions.current.summary_hash, "9/6のB適用前後を分ける");
assert.equal(septemberSixth.versions.current.summary_hash, septemberSixth.versions.published.summary_hash, "現行公開版version 2を識別する");
assert.deepEqual(septemberSixth.known_claim_evidence_bindings.map((item) => `${item.claim_ref}/${item.evidence_ref}`), ["C12/E5"]);
assert.equal(septemberSixth.evidence.some((item) => item.evidence_ref === "E5" && item.storage_state === "review_supplement_excerpt"), true);
assert.equal(septemberSixth.evidence.find((item) => item.evidence_ref === "E5")?.fetched_at, "2026-09-06T13:25:46.143Z");
assert.equal(manifest.articles.every((item) => item.missing_reasons.includes("exact_generation_evidence_array_missing")), true);
assert.equal("quality_scores" in manifest, false, "C0では自動採点しない");

await assert.rejects(
  writeQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot, output: path.join(dataRoot, "forbidden.json") }),
  /evaluation_output_resolves_inside_input_data_root/u
);

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "stage-c-evaluation-"));
try {
  const output = path.join(temporaryDirectory, "manifest.json");
  await writeQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot, output });
  const written = JSON.parse(await fs.readFile(output, "utf8")) as { totals: { articles: number } };
  assert.equal(written.totals.articles, 11);
  await assert.rejects(
    writeQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot, output }),
    /evaluation_output_already_exists/u
  );

  const dataAlias = path.join(temporaryDirectory, "data-alias");
  await fs.symlink(dataRoot, dataAlias, "junction");
  await assert.rejects(
    writeQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot, output: path.join(dataAlias, "aliased-overwrite.json") }),
    /evaluation_output_resolves_inside_input_data_root/u
  );

  const harmlessTarget = path.join(temporaryDirectory, "normal-target.json");
  await fs.writeFile(harmlessTarget, "unchanged", "utf8");
  const fileLink = path.join(temporaryDirectory, "existing-output-link.json");
  await fs.link(harmlessTarget, fileLink);
  await assert.rejects(
    writeQualityEvaluationManifest({ data_root: dataRoot, repository_root: repositoryRoot, output: fileLink }),
    /evaluation_output_already_exists/u
  );
  assert.equal(await fs.readFile(harmlessTarget, "utf8"), "unchanged");

  const inconsistentDataRoot = path.join(temporaryDirectory, "inconsistent-data");
  await fs.mkdir(inconsistentDataRoot);
  await fs.cp(path.join(dataRoot, "2026-09-06"), path.join(inconsistentDataRoot, "2026-09-06"), { recursive: true });
  const inconsistentArticlesPath = path.join(inconsistentDataRoot, "2026-09-06/articles_2026-09-06.json");
  const inconsistentArticles = JSON.parse(await fs.readFile(inconsistentArticlesPath, "utf8")) as Array<{ summary: { title_ja: string } }>;
  inconsistentArticles[0]!.summary.title_ja += "（実articles差分）";
  await fs.writeFile(inconsistentArticlesPath, `${JSON.stringify(inconsistentArticles, null, 2)}\n`, "utf8");
  const inconsistent = await buildQualityEvaluationManifest({
    data_root: inconsistentDataRoot,
    repository_root: repositoryRoot,
    repository_sha: "f".repeat(40),
    dates: ["2026-09-06"]
  });
  assert.match(inconsistent.articles[0]?.versions.current.summary?.title_ja ?? "", /実articles差分/u, "currentはrevisionで置換せず実articlesから取る");
  assert.equal(inconsistent.articles[0]?.diagnostics.some((item) => item.code === "current_summary_revision_mismatch"), true);

  const inconsistentReviewPath = path.join(inconsistentDataRoot, "2026-09-06/review.json");
  const inconsistentReview = JSON.parse(await fs.readFile(inconsistentReviewPath, "utf8")) as { articles: Array<{ index: number; article_id?: string; topic_key: string; current_version?: number }> };
  inconsistentReview.articles[0]!.index = 2;
  await fs.writeFile(inconsistentReviewPath, `${JSON.stringify(inconsistentReview, null, 2)}\n`, "utf8");
  const badIndex = await buildQualityEvaluationManifest({ data_root: inconsistentDataRoot, repository_root: repositoryRoot, repository_sha: "f".repeat(40), dates: ["2026-09-06"] });
  assert.equal(badIndex.articles[0]?.diagnostics.some((item) => item.code === "article_index_mismatch"), true);

  inconsistentReview.articles[0]!.index = 1;
  inconsistentReview.articles[0]!.current_version = 1;
  await fs.writeFile(inconsistentReviewPath, `${JSON.stringify(inconsistentReview, null, 2)}\n`, "utf8");
  const versionMismatch = await buildQualityEvaluationManifest({ data_root: inconsistentDataRoot, repository_root: repositoryRoot, repository_sha: "f".repeat(40), dates: ["2026-09-06"] });
  assert.equal(versionMismatch.articles[0]?.diagnostics.some((item) => item.code === "review_store_current_version_mismatch"), true);

  inconsistentReview.articles[0]!.article_id = "a-wrong";
  inconsistentReview.articles[0]!.topic_key = "別topic";
  inconsistentReview.articles[0]!.current_version = 1;
  await fs.writeFile(inconsistentReviewPath, `${JSON.stringify(inconsistentReview, null, 2)}\n`, "utf8");
  const identityMismatch = await buildQualityEvaluationManifest({ data_root: inconsistentDataRoot, repository_root: repositoryRoot, repository_sha: "f".repeat(40), dates: ["2026-09-06"] });
  const mismatchCodes = identityMismatch.articles[0]!.diagnostics.map((item) => item.code);
  assert.equal(mismatchCodes.includes("article_id_mismatch"), true);
  assert.equal(mismatchCodes.includes("topic_identity_mismatch"), true);
  assert.equal(mismatchCodes.includes("published_snapshot_unverified"), true);
  assert.equal(identityMismatch.articles[0]?.versions.published.available, false, "整合不能なcurrentをpublished snapshotへ代用しない");
  assert.equal(await hashBaselineInputs(dataRoot, expected.dates.map((item) => item.date)), beforeHash, "CLI出力後もinput dataは不変");
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`Stage C evaluation manifest: 7 dates / ${manifest.totals.articles} articles / ${manifest.totals.ledger_fallback} fallback; read-only checks passed`);

async function hashBaselineInputs(root: string, dates: string[]) {
  const hash = createHash("sha256");
  for (const date of dates) {
    const directory = path.join(root, date);
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      hash.update(`${date}/${name}\u0000`);
      hash.update(await fs.readFile(file));
    }
  }
  return hash.digest("hex");
}
