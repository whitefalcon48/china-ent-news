import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewArticle, ReviewArticleStatus, ReviewRevisionStore, ReviewRevisionTrace, StoredReviewProposal, SummarizedArticle } from "../types.js";

function now() {
  return new Date().toISOString();
}

export function revisionStorePath(directory: string) {
  return path.join(directory, "revisions.json");
}

/** Preserve the original request when an editor refines a pending proposal. */
export function appendProposalInstruction(previous: string, additional: string) {
  return `${previous.trim()}\n\n追加指示:\n${additional.trim()}`;
}

/** A failed replacement proposal must leave the visible old proposal intact. */
export function restorePendingProposalState(target: ReviewArticle, proposal: StoredReviewProposal) {
  target.status = "proposal_pending";
  target.pending_proposal_id = proposal.id;
  target.comment = proposal.instruction;
}

/**
 * articles JSON and revisions.json form one logical edit.  Restore both bytes
 * if a later write fails so Actions cannot commit a half-applied revision.
 */
export async function withReviewMutationTransaction<T>(directory: string, articlePath: string, operation: () => Promise<T>) {
  return withFileTransaction([articlePath, revisionStorePath(directory)], operation);
}

export async function beginFileTransaction(targets: string[]) {
  const snapshots = await Promise.all(targets.map(async (target) => {
    try {
      return { target, content: await fs.readFile(target, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target, content: null };
      throw error;
    }
  }));
  return {
    rollback: async () => {
      await Promise.all(snapshots.map(async ({ target, content }) => {
      if (content === null) {
        await fs.rm(target, { force: true });
      } else {
        await fs.writeFile(target, content, "utf8");
      }
      }));
    }
  };
}

export async function withFileTransaction<T>(targets: string[], operation: () => Promise<T>) {
  const transaction = await beginFileTransaction(targets);
  try {
    return await operation();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function readRevisionStore(directory: string, date: string): Promise<ReviewRevisionStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(revisionStorePath(directory), "utf8")) as ReviewRevisionStore;
    if (parsed.version !== 1 || parsed.date !== date || !parsed.articles || Array.isArray(parsed.articles)) {
      throw new Error("Invalid revisions.json");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, date, articles: {} };
  }
}

export async function writeRevisionStore(directory: string, store: ReviewRevisionStore) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(revisionStorePath(directory), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function entryFor(store: ReviewRevisionStore, articleId: string, current: SummarizedArticle) {
  const existing = store.articles[articleId];
  if (existing) return existing;
  const entry = {
    current_version: 1,
    versions: [{
      n: 1,
      parent: null,
      created_at: now(),
      created_by: "initial",
      summary: "生成直後の初稿",
      article_summary: structuredClone(current)
    }],
    proposals: [] as StoredReviewProposal[]
  };
  store.articles[articleId] = entry;
  return entry;
}

/** Persist the first immutable snapshot before any edit or proposal is made. */
export async function ensureInitialVersion(directory: string, date: string, articleId: string, current: SummarizedArticle) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current);
  await writeRevisionStore(directory, store);
  return { store, currentVersion: entry.current_version };
}

export async function appendAppliedVersion(
  directory: string,
  date: string,
  articleId: string,
  before: SummarizedArticle,
  after: SummarizedArticle,
  createdBy: string,
  summary: string
) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, before);
  const n = entry.current_version + 1;
  entry.versions.push({
    n,
    parent: entry.current_version,
    created_at: now(),
    created_by: createdBy,
    summary,
    article_summary: structuredClone(after)
  });
  entry.current_version = n;
  await writeRevisionStore(directory, store);
  return n;
}

export async function saveProposal(
  directory: string,
  date: string,
  articleId: string,
  current: SummarizedArticle,
  proposal: Omit<StoredReviewProposal, "id" | "base_version" | "created_at" | "status">
) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current);
  const id = `p-${entry.proposals.length + 1}`;
  const stored: StoredReviewProposal = {
    ...proposal,
    id,
    base_version: entry.current_version,
    created_at: now(),
    status: "pending",
    article_summary: structuredClone(proposal.article_summary)
  };
  entry.proposals.push(stored);
  await writeRevisionStore(directory, store);
  return stored;
}

export async function applyProposal(directory: string, date: string, articleId: string, proposalId: string) {
  const store = await readRevisionStore(directory, date);
  const entry = store.articles[articleId];
  if (!entry) throw new Error("修正案の履歴が見つかりません");
  const proposal = entry.proposals.find((item) => item.id === proposalId);
  if (!proposal || proposal.status !== "pending") throw new Error("適用できる修正案が見つかりません");
  if (proposal.base_version !== entry.current_version) {
    throw new Error("この修正案は元の記事が更新された後の案ではないため、適用できません。もう一度修正案を作ってください。");
  }
  const n = entry.current_version + 1;
  entry.versions.push({
    n,
    parent: entry.current_version,
    created_at: now(),
    created_by: `proposal:${proposal.id}`,
    summary: proposal.summary,
    article_summary: structuredClone(proposal.article_summary)
  });
  entry.current_version = n;
  proposal.status = "applied";
  await writeRevisionStore(directory, store);
  return { summary: structuredClone(proposal.article_summary), version: n, proposal };
}

export async function discardProposal(directory: string, date: string, articleId: string, proposalId: string) {
  const store = await readRevisionStore(directory, date);
  const proposal = store.articles[articleId]?.proposals.find((item) => item.id === proposalId);
  if (!proposal || proposal.status !== "pending") throw new Error("破棄できる修正案が見つかりません");
  proposal.status = "discarded";
  await writeRevisionStore(directory, store);
  return proposal;
}

export async function revertToVersion(directory: string, date: string, articleId: string, current: SummarizedArticle, target: "initial" | "previous") {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current);
  const targetNumber = target === "initial" ? 1 : Math.max(1, entry.current_version - 1);
  const source = entry.versions.find((version) => version.n === targetNumber);
  if (!source) throw new Error("戻す元の版が見つかりません");
  const n = entry.current_version + 1;
  entry.versions.push({
    n,
    parent: entry.current_version,
    created_at: now(),
    created_by: `revert:${targetNumber}`,
    summary: target === "initial" ? "初稿へ戻す" : "一つ前の版へ戻す",
    article_summary: structuredClone(source.article_summary)
  });
  entry.current_version = n;
  await writeRevisionStore(directory, store);
  return { summary: structuredClone(source.article_summary), version: n };
}
