import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareEvidenceSupplement, type EvidenceSupplementRequest } from "./evidenceSupplement.js";
import { formatReviewArticle, formatReviewProposalSummary } from "./buildReviewIssueBody.js";
import { ensureInitialVersion, readRevisionStore, revisionStorePath, saveProposal, snapshotReviewArticle, withFileTransaction } from "./revisionStore.js";
import { readReviewState, writeReviewState } from "./reviewState.js";
import { findLedger } from "./reviseArticle.js";
import type { ProcessedArticle, ReviewState } from "../types.js";

export type EvidenceSupplementInput = {
  date: string;
  issue_number: number;
  index: number;
  article_id: string;
  topic_key: string;
  base_summary_sha256: string;
  supplement: EvidenceSupplementRequest;
};

export type PrepareEvidenceSupplementOptions = {
  dataDir?: string;
  write?: boolean;
  /** Set only after the operator has checked source subject and meaning. */
  confirmSourceReviewed?: boolean;
  fetchDocument?: NonNullable<Parameters<typeof prepareEvidenceSupplement>[3]>["fetchDocument"];
};

export async function prepareEvidenceSupplementProposal(input: EvidenceSupplementInput, options: PrepareEvidenceSupplementOptions = {}) {
  assertInput(input);
  const dataDir = path.resolve(options.dataDir ?? "data");
  const directory = resolveDayDirectory(dataDir, input.date);
  const articlePath = await storedArticlePath(directory, input.date);
  const reviewPath = path.join(directory, "review.json");
  const articleBytes = await fs.readFile(articlePath, "utf8");
  const reviewBytes = await fs.readFile(reviewPath, "utf8");
  const revisionsPath = revisionStorePath(directory);
  const revisionsBytes = await readOptional(revisionsPath);
  const articles = JSON.parse(articleBytes) as ProcessedArticle[];
  const state = await readReviewState(reviewPath);
  const current = articles[input.index - 1];
  const target = state.articles.find((item) => item.index === input.index);
  if (!current?.summary || !current.topic || !target) throw new Error("指定記事を確認できませんでした");
  if (state.date !== input.date || state.issue_number !== input.issue_number) throw new Error("reviewの日付またはIssue番号が一致しません");
  if (target.article_id !== input.article_id || target.topic_key !== input.topic_key || current.topic.topic_key !== input.topic_key) throw new Error("article_idまたはtopic_keyが一致しません");
  if (summaryHash(current.summary) !== input.base_summary_sha256) throw new Error("base_summary_sha256が現在の記事と一致しません");
  if (target.pending_proposal_id || target.status === "proposal_pending") throw new Error("既存の修正案を確認中のため、新しい補足案は作成しません");
  await assertCurrentVersion(directory, input, target, current);
  const ledger = await findLedger(directory, current.topic.topic_key, current);
  if (!ledger) throw new Error("保存済みfact ledgerがないため、補足案を作成できません");

  const result = await prepareEvidenceSupplement(current, ledger, input.supplement, options.fetchDocument ? { fetchDocument: options.fetchDocument } : undefined);
  const proposalView = {
    instruction: input.supplement.instruction,
    summary: result.summary,
    trace: result.trace,
    evidence_urls: result.evidenceUrls,
    article_state: snapshotReviewArticle(result.article)
  };
  const output = `${formatReviewArticle(input.index, result.article, true)}\n\n${formatReviewProposalSummary(proposalView)}`;
  if (!options.write) return { written: false, output, article: result.article, trace: result.trace, supplement: result.supplement };
  if (!options.confirmSourceReviewed) throw new Error("--write には、出典の主語と説明の意味を確認した後で --confirm-source-reviewed が必要です");

  // Do not overwrite an editor's concurrent review or article edit. The
  // articles document is intentionally never a transaction target: it must
  // remain byte-for-byte identical for a proposal-only operation.
  await withFileTransaction([reviewPath, revisionStorePath(directory)], async () => {
    if (await fs.readFile(articlePath, "utf8") !== articleBytes) throw new Error("記事が同時に更新されたため、補足案は保存しません");
    if (await fs.readFile(reviewPath, "utf8") !== reviewBytes) throw new Error("reviewが同時に更新されたため、補足案は保存しません");
    if (await readOptional(revisionsPath) !== revisionsBytes) throw new Error("版履歴が同時に更新されたため、補足案は保存しません");
    const latest = await readReviewState(reviewPath);
    const latestTarget = latest.articles.find((item) => item.index === input.index);
    if (!latestTarget || latestTarget.article_id !== input.article_id || latestTarget.pending_proposal_id || latestTarget.status === "proposal_pending") throw new Error("既存の修正案を確認中のため、新しい補足案は保存しません");
    await assertCurrentVersion(directory, input, latestTarget, current);
    const initialized = await ensureInitialVersion(directory, input.date, input.article_id, current.summary!, snapshotReviewArticle(current));
    const proposal = await saveProposal(directory, input.date, input.article_id, current.summary!, {
      instruction: input.supplement.instruction,
      mode: "limited_patch",
      summary: result.summary,
      trace: result.trace,
      evidence_urls: result.evidenceUrls,
      previous_status: latestTarget.status,
      article_summary: result.article.summary!,
      article_state: snapshotReviewArticle(result.article)
    }, snapshotReviewArticle(current));
    latestTarget.current_version = initialized.currentVersion;
    latestTarget.status = "proposal_pending";
    latestTarget.pending_proposal_id = proposal.id;
    latestTarget.reason_tag = "事実";
    latestTarget.comment = input.supplement.instruction;
    latest.status = "pending";
    await writeReviewState(reviewPath, latest);
    if (await fs.readFile(articlePath, "utf8") !== articleBytes) throw new Error("記事本文が変更されたため、補足案を保存しません");
  });
  return { written: true, output, article: result.article, trace: result.trace, supplement: result.supplement };
}

async function assertCurrentVersion(directory: string, input: EvidenceSupplementInput, target: ReviewState["articles"][number], current: ProcessedArticle) {
  const store = await readRevisionStore(directory, input.date);
  const entry = store.articles[input.article_id];
  if (!entry) return;
  if (entry.current_version !== (target.current_version ?? 1)) throw new Error("reviewと版履歴のcurrent_versionが一致しません");
  const version = entry.versions.find((item) => item.n === entry.current_version);
  if (!version || JSON.stringify(version.article_summary) !== JSON.stringify(current.summary)) throw new Error("版履歴の現行本文が記事本文と一致しません");
}

async function readOptional(filePath: string) {
  try { return await fs.readFile(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function assertInput(input: EvidenceSupplementInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("dateはYYYY-MM-DDで指定してください");
  if (!Number.isInteger(input.issue_number) || input.issue_number < 1 || !Number.isInteger(input.index) || input.index < 1) throw new Error("issue_numberとindexは正の整数で指定してください");
  if (!input.article_id || !input.topic_key || !/^[a-f0-9]{64}$/i.test(input.base_summary_sha256)) throw new Error("article_id、topic_key、base_summary_sha256を確認してください");
}

function resolveDayDirectory(dataDir: string, date: string) {
  const directory = path.resolve(dataDir, date);
  if (path.dirname(directory) !== dataDir) throw new Error("dataDir外の日付は指定できません");
  return directory;
}

async function storedArticlePath(directory: string, date: string) {
  const name = `articles_${date}.json`;
  const articlePath = path.join(directory, name);
  await fs.access(articlePath);
  return articlePath;
}

export function summaryHash(summary: ProcessedArticle["summary"]) {
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}

async function main() {
  const requestIndex = process.argv.indexOf("--request");
  if (requestIndex < 0 || !process.argv[requestIndex + 1]) throw new Error("--request <json> が必要です");
  const requestPath = path.resolve(process.argv[requestIndex + 1]);
  const input = JSON.parse(await fs.readFile(requestPath, "utf8")) as EvidenceSupplementInput;
  const result = await prepareEvidenceSupplementProposal(input, {
    dataDir: process.env.SITE_DATA_DIR,
    write: process.argv.includes("--write"),
    confirmSourceReviewed: process.argv.includes("--confirm-source-reviewed")
  });
  console.log(`未適用・未公開の修正案です。\n\n${result.output}`);
  console.log(result.written ? `\n補足案を保存しました。適用するには通常の『${input.index} 適用』を使います。` : "\nドライランです。保存するには --write --confirm-source-reviewed を付けてください。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
