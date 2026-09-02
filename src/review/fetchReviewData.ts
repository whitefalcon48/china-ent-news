import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessedArticle, ReviewState } from "../types.js";

/** UIが表示する版情報。旧データでは存在しないため、詳細な型は意図的に緩く保つ。 */
export type ReviewUiRevisions = {
  [key: string]: unknown;
};

const execFileAsync = promisify(execFile);

export type ReviewUiDay = {
  date: string;
  issueNumber: number;
  issueUrl: string;
  review: ReviewState;
  articles: ProcessedArticle[];
  revisions?: ReviewUiRevisions;
};

export type ReviewUiData = {
  days: ReviewUiDay[];
  warning: string;
  source: "github" | "local";
};

export type ReviewCommandRunner = (command: string, args: string[]) => Promise<string>;

export async function fetchReviewData(options: {
  dryRun?: boolean;
  dataDir?: string;
  runner?: ReviewCommandRunner;
} = {}): Promise<ReviewUiData> {
  const dataDir = path.resolve(options.dataDir || process.env.SITE_DATA_DIR || "data");
  const runner = options.runner || runCommand;
  if (options.dryRun) return loadLocalReviewData(dataDir, "dry-run: ローカルデータを表示しています。GitHubへの送信は行いません。", runner);

  try {
    const repository = await resolveRepository(runner);
    // Completed reviews are normally closed, but a completed day can still
    // contain held articles.  Query both states independently so a busy open
    // queue cannot hide the hold shelf behind the CLI's 100-result limit.
    const [openIssues, closedIssues] = await Promise.all([
      listReviewIssues("open", runner),
      listReviewIssues("closed", runner)
    ]);
    const issues = [...new Map([...openIssues, ...closedIssues].map((issue) => [issue.number, issue])).values()];
    const days: ReviewUiDay[] = [];
    for (const issue of issues) {
      const date = issue.title.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (!date) continue;
      const [review, articles, revisions] = await Promise.all([
        fetchGithubJson<ReviewState>(repository, `data/${date}/review.json`, runner),
        fetchGithubJson<ProcessedArticle[]>(repository, `data/${date}/articles_${date}.json`, runner),
        fetchOptionalGithubJson<ReviewUiRevisions>(repository, `data/${date}/revisions.json`, runner)
      ]);
      if (review.status === "completed" && !hasHeldArticle(review)) continue;
      days.push({ date, issueNumber: issue.number, issueUrl: issue.url, review, articles, revisions });
    }
    return { days: days.sort((left, right) => right.date.localeCompare(left.date)), warning: "", source: "github" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return loadLocalReviewData(dataDir, `GitHubから取得できなかったためローカルデータを表示しています。内容が古い可能性があります。\n${detail}`, runner);
  }
}

export async function loadLocalReviewData(dataDir: string, warning: string, runner: ReviewCommandRunner = runCommand): Promise<ReviewUiData> {
  let repository = "";
  try {
    repository = await resolveRepository(runner);
  } catch {
    repository = "";
  }
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const days: ReviewUiDay[] = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = path.join(dataDir, entry.name);
    try {
      const review = JSON.parse(await fs.readFile(path.join(directory, "review.json"), "utf8")) as ReviewState;
      if (review.status === "completed" && !hasHeldArticle(review)) continue;
      const articleName = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
      if (!articleName) continue;
      const articles = JSON.parse(await fs.readFile(path.join(directory, articleName), "utf8")) as ProcessedArticle[];
      const issueNumber = review.issue_number || 0;
      days.push({
        date: entry.name,
        issueNumber,
        issueUrl: repository && issueNumber ? `https://github.com/${repository}/issues/${issueNumber}` : "",
        review,
        articles,
        revisions: await readOptionalJson<ReviewUiRevisions>(path.join(directory, "revisions.json"))
      });
    } catch (error) {
      console.warn(`review UI local warning (${entry.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { days, warning, source: "local" };
}

export async function checkGithubCli(runner: ReviewCommandRunner = runCommand) {
  try {
    await runner("gh", ["--version"]);
  } catch {
    return { ready: false, reason: "GitHub CLI（gh）がインストールされていません。" };
  }
  try {
    await runner("gh", ["auth", "status"]);
    return { ready: true, reason: "" };
  } catch {
    return { ready: false, reason: "GitHub CLIにログインしていません。" };
  }
}

export async function resolveRepository(runner: ReviewCommandRunner = runCommand) {
  const parsed = JSON.parse(await runner("gh", ["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner?: string };
  if (!parsed.nameWithOwner || !/^[^/]+\/[^/]+$/.test(parsed.nameWithOwner)) throw new Error("GitHub repositoryを特定できませんでした");
  return parsed.nameWithOwner;
}

async function fetchGithubJson<T>(repository: string, filePath: string, runner: ReviewCommandRunner): Promise<T> {
  const response = JSON.parse(await runner("gh", ["api", "--method", "GET", `repos/${repository}/contents/${filePath}`, "-f", "ref=main"])) as { content?: string; encoding?: string };
  if (response.encoding !== "base64" || !response.content) throw new Error(`GitHub content responseが不正です: ${filePath}`);
  return JSON.parse(Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8")) as T;
}

type ReviewIssue = { number: number; title: string; url: string };

async function listReviewIssues(state: "open" | "closed", runner: ReviewCommandRunner): Promise<ReviewIssue[]> {
  const parsed = JSON.parse(await runner("gh", ["issue", "list", "--label", "daily-review", "--state", state, "--limit", "100", "--json", "number,title,url"])) as unknown;
  if (!Array.isArray(parsed)) throw new Error("GitHub review issue listが不正です");
  return parsed.filter((item): item is ReviewIssue => {
    if (!item || typeof item !== "object") return false;
    const value = item as Partial<ReviewIssue>;
    return Number.isInteger(value.number) && typeof value.title === "string" && typeof value.url === "string";
  });
}

async function fetchOptionalGithubJson<T>(repository: string, filePath: string, runner: ReviewCommandRunner): Promise<T | undefined> {
  try {
    return await fetchGithubJson<T>(repository, filePath, runner);
  } catch {
    return undefined;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`review UI optional revisions warning (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function hasHeldArticle(review: ReviewState) {
  return review.articles.some((article) => (article as ReviewState["articles"][number] & { status?: string }).status === "held");
}

export async function runCommand(command: string, args: string[]) {
  const result = await execFileAsync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}
