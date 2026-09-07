import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeEvidenceUrl } from "../evidence/evidenceManifest.js";
import type {
  FactLedger,
  ProcessedArticle,
  ReviewEvidenceSupplement,
  ReviewRevisionStore,
  ReviewState,
  SummarizedArticle
} from "../types.js";
import type {
  EvaluationEvidenceRecord,
  EvaluationFileRecord,
  EvaluationVersionSnapshot,
  QualityEvaluationArticle,
  QualityEvaluationManifest
} from "./types.js";

const execFileAsync = promisify(execFile);
export const STAGE_C_BASELINE_DATES = [
  "2026-08-31",
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-05",
  "2026-09-06"
] as const;

type LedgerFile = {
  ledgers?: Array<{ topic_key: string; ledger: FactLedger | null; fallback_reason?: string }>;
};

export type BuildQualityEvaluationManifestOptions = {
  data_root: string;
  repository_root?: string;
  repository_sha?: string | null;
  dates?: readonly string[];
};

export async function buildQualityEvaluationManifest(
  options: BuildQualityEvaluationManifestOptions
): Promise<QualityEvaluationManifest> {
  const dataRoot = path.resolve(options.data_root);
  const repositoryRoot = path.resolve(options.repository_root ?? path.dirname(dataRoot));
  const dates = [...(options.dates ?? STAGE_C_BASELINE_DATES)];
  const repositorySha = options.repository_sha === undefined ? await readRepositorySha(repositoryRoot) : options.repository_sha;
  const articles: QualityEvaluationArticle[] = [];
  const dateRecords: QualityEvaluationManifest["dates"] = [];

  for (const date of dates) {
    const directory = path.join(dataRoot, date);
    const files = await readDateFiles(directory, date, repositoryRoot);
    const processed = parseJson<ProcessedArticle[]>(files.articles.content, []);
    const review = parseJson<ReviewState>(files.review.content, { date, status: "pending", issue_number: 0, articles: [] });
    const ledgerFile = parseJson<LedgerFile>(files.ledger.content, {});
    const revisions = parseJson<ReviewRevisionStore | null>(files.revisions.content, null);
    const inputFiles = [files.articles.record, files.review.record, files.ledger.record, files.revisions.record];
    dateRecords.push({ date, article_count: processed.length, zero_article_day: processed.length === 0, input_files: inputFiles });

    processed.forEach((article, offset) => {
      articles.push(buildArticleRecord({
        article,
        date,
        index: offset + 1,
        review,
        ledgerFile,
        revisions,
        repositorySha,
        inputFiles
      }));
    });
  }

  const rawBodyAvailable = articles.flatMap((article) => article.evidence).filter((item) => item.raw_body_available).length;
  const evidenceTotal = articles.flatMap((article) => article.evidence).length;
  return {
    version: 1,
    scope: {
      start_date: dates[0] ?? "",
      end_date: dates.at(-1) ?? "",
      expected_article_count: 11
    },
    repository_sha: repositorySha,
    dates: dateRecords,
    articles,
    totals: {
      dates: dates.length,
      articles: articles.length,
      zero_article_days: dateRecords.filter((item) => item.zero_article_day).length,
      ledger_generated: articles.filter((article) => article.ledger_generation.status === "generated").length,
      ledger_fallback: articles.filter((article) => article.ledger_generation.status === "fallback").length,
      raw_body_available: rawBodyAvailable,
      raw_body_missing: evidenceTotal - rawBodyAvailable,
      known_claim_evidence_bindings: articles.reduce((total, article) => total + article.known_claim_evidence_bindings.length, 0),
      unresolved_claim_evidence_pairs: articles.reduce((total, article) => total + article.unresolved_claim_evidence_pairs, 0),
      comparable_articles: articles.filter((article) => article.comparable).length
    }
  };
}

export async function writeQualityEvaluationManifest(
  options: BuildQualityEvaluationManifestOptions & { output: string }
) {
  const dataRoot = path.resolve(options.data_root);
  const output = path.resolve(options.output);
  if (isWithin(dataRoot, output)) throw new Error("evaluation_output_must_not_be_inside_input_data_root");
  const manifest = await buildQualityEvaluationManifest(options);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function buildArticleRecord(input: {
  article: ProcessedArticle;
  date: string;
  index: number;
  review: ReviewState;
  ledgerFile: LedgerFile;
  revisions: ReviewRevisionStore | null;
  repositorySha: string | null;
  inputFiles: EvaluationFileRecord[];
}): QualityEvaluationArticle {
  const topicKey = input.article.topic?.topic_key ?? input.article.generationMeta?.topic_key ?? input.article.summary?.topic_key ?? "";
  const reviewArticle = input.review.articles.find((candidate) => candidate.index === input.index);
  const articleId = reviewArticle?.article_id ?? null;
  const revisionEntry = articleId ? input.revisions?.articles?.[articleId] : undefined;
  const currentSummary = input.article.summary;
  const versions = buildVersions(currentSummary, reviewArticle?.current_version, reviewArticle?.publication?.published_version, revisionEntry);
  const generatedLedger = input.ledgerFile.ledgers?.find((entry) => entry.topic_key === topicKey);
  const fallbackReason = generatedLedger?.fallback_reason?.trim() || null;
  const ledgerStatus = generatedLedger?.ledger ? "generated" : fallbackReason ? "fallback" : "missing";
  const evidence = collectEvidence(input.article);
  const knownBindings = collectKnownBindings(input.article.generationMeta?.review_supplements ?? []);
  const pairKeys = collectClaimEvidencePairs(generatedLedger?.ledger, input.article.generationMeta?.ledger);
  const knownKeys = new Set(knownBindings.map((item) => `${item.claim_ref}\u0000${item.evidence_ref}`));
  const unresolvedPairs = [...pairKeys].filter((key) => !knownKeys.has(key)).length;
  const missingReasons = new Set<string>(["exact_generation_evidence_array_missing"]);
  if (!articleId) missingReasons.add("article_id_missing");
  if (!revisionEntry) missingReasons.add("draft_version_metadata_missing");
  if (ledgerStatus === "fallback") missingReasons.add("ledger_generation_failed");
  if (unresolvedPairs > 0) missingReasons.add("legacy_claim_evidence_binding_unresolved");
  if (evidence.some((item) => !item.raw_body_available)) missingReasons.add("raw_source_body_missing");
  if (evidence.some((item) => !item.fetched_at)) missingReasons.add("evidence_fetched_at_missing");
  if (reviewArticle?.publication?.published_version && !versions.published.available) missingReasons.add("published_snapshot_missing");

  return {
    date: input.date,
    index: input.index,
    topic_key: topicKey,
    article_id: articleId,
    title: currentSummary?.title_ja ?? input.article.raw.title,
    repository_sha: input.repositorySha,
    input_files: input.inputFiles,
    versions,
    ledger_generation: {
      status: ledgerStatus,
      ledger_used: ledgerStatus === "generated",
      failure_reason: fallbackReason
    },
    evidence,
    known_claim_evidence_bindings: knownBindings,
    unresolved_claim_evidence_pairs: unresolvedPairs,
    comparable: false,
    missing_reasons: [...missingReasons]
  };
}

function buildVersions(
  currentSummary: SummarizedArticle | undefined,
  currentVersion: number | undefined,
  publishedVersion: number | undefined,
  revisionEntry: ReviewRevisionStore["articles"][string] | undefined
) {
  const draftStored = revisionEntry?.versions.find((item) => item.n === 1)?.article_summary;
  const currentStored = revisionEntry?.versions.find((item) => item.n === (currentVersion ?? revisionEntry.current_version))?.article_summary;
  const publishedStored = publishedVersion === undefined
    ? undefined
    : revisionEntry?.versions.find((item) => item.n === publishedVersion)?.article_summary;
  const draft = draftStored
    ? versionSnapshot("draft", draftStored, 1, "revision_store", true)
    : currentSummary
      ? versionSnapshot("draft", currentSummary, null, "legacy_current_snapshot", false)
      : unavailableVersion("draft");
  const current = currentStored
    ? versionSnapshot("current", currentStored, currentVersion ?? revisionEntry?.current_version ?? null, "revision_store", true)
    : currentSummary
      ? versionSnapshot("current", currentSummary, currentVersion ?? null, "current_article", false)
      : unavailableVersion("current");
  let published = unavailableVersion("published");
  if (publishedVersion !== undefined) {
    if (publishedStored) {
      published = versionSnapshot("published", publishedStored, publishedVersion, "revision_store", true);
    } else if (currentSummary && publishedVersion === (currentVersion ?? 1)) {
      published = versionSnapshot("published", currentSummary, publishedVersion, "current_article", false);
    }
  }
  return { draft, current, published };
}

function versionSnapshot(
  kind: EvaluationVersionSnapshot["kind"],
  summary: SummarizedArticle,
  versionNumber: number | null,
  source: EvaluationVersionSnapshot["source"],
  separateSnapshot: boolean
): EvaluationVersionSnapshot {
  return {
    kind,
    available: true,
    version_number: versionNumber,
    summary_hash: sha256(JSON.stringify(summary)),
    source,
    separate_snapshot: separateSnapshot,
    summary
  };
}

function unavailableVersion(kind: EvaluationVersionSnapshot["kind"]): EvaluationVersionSnapshot {
  return { kind, available: false, version_number: null, summary_hash: null, source: "unavailable", separate_snapshot: false };
}

function collectEvidence(article: ProcessedArticle): EvaluationEvidenceRecord[] {
  const records = new Map<string, EvaluationEvidenceRecord>();
  for (const item of article.topic?.evidence_articles ?? []) {
    addCandidate(records, item, "root_corroboration");
  }
  for (const item of article.topic?.related_evidence_articles ?? []) {
    addCandidate(records, item, "related_angle");
  }
  const rawUrl = normalizeEvidenceUrl(article.raw.url);
  if (rawUrl) {
    const body = article.raw.rawContent ?? "";
    const existing = records.get(rawUrl);
    records.set(rawUrl, {
      normalized_url: rawUrl,
      source_name: article.raw.sourceName,
      title: article.raw.title,
      role: existing?.role ?? article.raw.evidenceRole ?? "root_corroboration",
      purpose: existing?.purpose ?? "generation",
      storage_state: body ? "raw_content" : article.raw.excerpt ? "excerpt_only" : "missing",
      raw_body_available: Boolean(body),
      body_sha256: body ? sha256(body) : null,
      fetched_at: null,
      evidence_ref: null,
      claim_ref: null,
      binding_status: "legacy_unresolved"
    });
  }
  for (const supplement of article.generationMeta?.review_supplements ?? []) {
    const normalizedUrl = normalizeEvidenceUrl(supplement.source_url);
    if (!normalizedUrl) continue;
    const existing = records.get(normalizedUrl);
    records.set(normalizedUrl, {
      normalized_url: normalizedUrl,
      source_name: supplement.source_name,
      title: supplement.source_title,
      role: "related_angle",
      purpose: "reader_context",
      storage_state: existing?.raw_body_available ? existing.storage_state : "review_supplement_excerpt",
      raw_body_available: existing?.raw_body_available ?? false,
      body_sha256: supplement.body_sha256 || existing?.body_sha256 || null,
      fetched_at: supplement.fetched_at || null,
      evidence_ref: supplement.evidence_ref,
      claim_ref: supplement.claim_ref,
      binding_status: "explicit_legacy_import"
    });
  }
  return [...records.values()];
}

function addCandidate(
  records: Map<string, EvaluationEvidenceRecord>,
  item: { title: string; url: string; source_name: string; key_points: string[] },
  role: EvaluationEvidenceRecord["role"]
) {
  const normalizedUrl = normalizeEvidenceUrl(item.url);
  if (!normalizedUrl || records.has(normalizedUrl)) return;
  const meaningfulPoints = item.key_points.filter((point) => point.trim() && point.trim() !== item.title.trim());
  records.set(normalizedUrl, {
    normalized_url: normalizedUrl,
    source_name: item.source_name,
    title: item.title,
    role,
    purpose: "generation",
    storage_state: meaningfulPoints.length ? "candidate_key_points" : item.key_points.length ? "title_only" : "missing",
    raw_body_available: false,
    body_sha256: null,
    fetched_at: null,
    evidence_ref: null,
    claim_ref: null,
    binding_status: "legacy_unresolved"
  });
}

function collectKnownBindings(supplements: ReviewEvidenceSupplement[]) {
  return supplements.flatMap((supplement) => {
    const normalizedUrl = normalizeEvidenceUrl(supplement.source_url);
    return normalizedUrl ? [{
      claim_ref: supplement.claim_ref,
      evidence_ref: supplement.evidence_ref,
      normalized_url: normalizedUrl,
      source: "review_supplement" as const
    }] : [];
  });
}

function collectClaimEvidencePairs(...ledgers: Array<FactLedger | null | undefined>) {
  const pairs = new Set<string>();
  for (const ledger of ledgers) {
    for (const claim of ledger?.claims ?? []) {
      for (const ref of claim.evidence_refs) pairs.add(`${claim.id}\u0000${ref}`);
    }
  }
  return pairs;
}

async function readDateFiles(directory: string, date: string, repositoryRoot: string) {
  const paths = {
    articles: path.join(directory, `articles_${date}.json`),
    review: path.join(directory, "review.json"),
    ledger: path.join(directory, `fact_ledger_${date}.json`),
    revisions: path.join(directory, "revisions.json")
  };
  const [articles, review, ledger, revisions] = await Promise.all([
    readFile(paths.articles, "articles", repositoryRoot, true),
    readFile(paths.review, "review", repositoryRoot, true),
    readFile(paths.ledger, "ledger", repositoryRoot, true),
    readFile(paths.revisions, "revisions", repositoryRoot, false)
  ]);
  return { articles, review, ledger, revisions };
}

async function readFile(filePath: string, kind: EvaluationFileRecord["kind"], repositoryRoot: string, required: boolean) {
  try {
    const content = await fs.readFile(filePath);
    return {
      content: content.toString("utf8"),
      record: {
        kind,
        path: toPosix(path.relative(repositoryRoot, filePath)),
        exists: true,
        git_blob_sha: await readWorkingTreeBlobSha(repositoryRoot, filePath, content)
      } satisfies EvaluationFileRecord
    };
  } catch (error) {
    if (required || !isMissingFile(error)) throw error;
    return {
      content: "",
      record: {
        kind,
        path: toPosix(path.relative(repositoryRoot, filePath)),
        exists: false,
        git_blob_sha: null
      } satisfies EvaluationFileRecord
    };
  }
}

function rawGitBlobSha(content: Buffer) {
  const header = Buffer.from(`blob ${content.length}\u0000`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function readWorkingTreeBlobSha(repositoryRoot: string, filePath: string, content: Buffer) {
  try {
    const relativePath = toPosix(path.relative(repositoryRoot, filePath));
    const result = await execFileAsync("git", ["hash-object", "--path", relativePath, filePath], { cwd: repositoryRoot, windowsHide: true });
    const value = result.stdout.trim();
    return /^[a-f0-9]{40}$/u.test(value) ? value : rawGitBlobSha(content);
  } catch {
    return rawGitBlobSha(content);
  }
}

async function readRepositorySha(repositoryRoot: string) {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, windowsHide: true });
    const value = result.stdout.trim();
    return /^[a-f0-9]{40}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function parseJson<T>(content: string, fallback: T): T {
  return content ? JSON.parse(content) as T : fallback;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("--output is required");
  const repositoryRoot = path.resolve(args.repository_root ?? process.cwd());
  const dataRoot = path.resolve(args.data_root ?? path.join(repositoryRoot, "data"));
  const manifest = await writeQualityEvaluationManifest({
    data_root: dataRoot,
    repository_root: repositoryRoot,
    output: args.output
  });
  console.log(`Stage C evaluation manifest: ${path.resolve(args.output)}`);
  console.log(`dates=${manifest.totals.dates} articles=${manifest.totals.articles} zero_days=${manifest.totals.zero_article_days}`);
  console.log(`ledger_generated=${manifest.totals.ledger_generated} ledger_fallback=${manifest.totals.ledger_fallback}`);
  console.log(`raw_available=${manifest.totals.raw_body_available} raw_missing=${manifest.totals.raw_body_missing}`);
  console.log(`known_bindings=${manifest.totals.known_claim_evidence_bindings} unresolved_pairs=${manifest.totals.unresolved_claim_evidence_pairs}`);
}

function parseArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    parsed[key.slice(2).replace(/-/gu, "_")] = value;
    index += 1;
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
