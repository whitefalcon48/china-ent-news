import fs from "node:fs/promises";
import path from "node:path";
import type { ProcessedArticle, ReviewArticle, ReviewArticleStatus, ReviewRevisionStore, ReviewRevisionTrace, StoredReviewArticleState, StoredReviewProposal, SummarizedArticle } from "../types.js";

function now() {
  return new Date().toISOString();
}

/** Snapshot only fields which review revisions are allowed to change. */
export function snapshotReviewArticle(article: ProcessedArticle): StoredReviewArticleState {
  if (!article.summary) throw new Error("記事本文を確認できないため、版を保存できません");
  return structuredClone({ summary: article.summary, ...(article.topic ? { topic: article.topic } : {}), ...(article.generationMeta ? { generationMeta: article.generationMeta } : {}) });
}

function assertStateMatchesSummary(state: StoredReviewArticleState | undefined, summary: SummarizedArticle, label: string) {
  if (state && JSON.stringify(state.summary) !== JSON.stringify(summary)) throw new Error(`${label}の本文と記事stateが一致しません`);
}

/** Restore a new-format snapshot without leaking future evidence into an old version. */
export function restoreReviewArticleState(current: ProcessedArticle, state: StoredReviewArticleState | undefined, summary: SummarizedArticle): ProcessedArticle {
  if (!state) return { ...current, summary: structuredClone(summary) };
  if (JSON.stringify(state.summary) !== JSON.stringify(summary)) throw new Error("版履歴の本文と記事stateが一致しません");
  const { topic: _topic, generationMeta: _generationMeta, ...preserved } = current;
  return {
    ...preserved,
    summary: structuredClone(state.summary),
    ...(state.topic ? { topic: structuredClone(state.topic) } : {}),
    ...(state.generationMeta ? { generationMeta: structuredClone(state.generationMeta) } : {})
  };
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

function entryFor(store: ReviewRevisionStore, articleId: string, current: SummarizedArticle, currentState?: StoredReviewArticleState) {
  assertStateMatchesSummary(currentState, current, "初稿");
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
      article_summary: structuredClone(current),
      ...(currentState ? { article_state: structuredClone(currentState) } : {})
    }],
    proposals: [] as StoredReviewProposal[]
  };
  store.articles[articleId] = entry;
  return entry;
}

/** Persist the first immutable snapshot before any edit or proposal is made. */
export async function ensureInitialVersion(directory: string, date: string, articleId: string, current: SummarizedArticle, currentState?: StoredReviewArticleState) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current, currentState);
  const currentVersion = entry.versions.find((version) => version.n === entry.current_version);
  // A legacy current version can be safely enriched only when its text is the
  // exact current text; older versions remain explicitly snapshot-less.
  if (currentState && currentVersion && !currentVersion.article_state && JSON.stringify(currentVersion.article_summary) === JSON.stringify(current)) {
    currentVersion.article_state = structuredClone(currentState);
  }
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
  summary: string,
  beforeState?: StoredReviewArticleState,
  afterState?: StoredReviewArticleState
) {
  assertStateMatchesSummary(beforeState, before, "変更前の版");
  assertStateMatchesSummary(afterState, after, "変更後の版");
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, before, beforeState);
  const n = entry.current_version + 1;
  entry.versions.push({
    n,
    parent: entry.current_version,
    created_at: now(),
    created_by: createdBy,
    summary,
    article_summary: structuredClone(after),
    ...(afterState ? { article_state: structuredClone(afterState) } : {})
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
  proposal: Omit<StoredReviewProposal, "id" | "base_version" | "created_at" | "status">,
  currentState?: StoredReviewArticleState
) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current, currentState);
  const id = `p-${entry.proposals.length + 1}`;
  const stored: StoredReviewProposal = {
    ...proposal,
    id,
    base_version: entry.current_version,
    created_at: now(),
    status: "pending",
    article_summary: structuredClone(proposal.article_summary),
    ...(proposal.article_state ? { article_state: structuredClone(proposal.article_state) } : {})
  };
  assertStateMatchesSummary(stored.article_state, stored.article_summary, "修正案");
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
  assertStateMatchesSummary(proposal.article_state, proposal.article_summary, "修正案");
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
    article_summary: structuredClone(proposal.article_summary),
    ...(proposal.article_state ? { article_state: structuredClone(proposal.article_state) } : {})
  });
  entry.current_version = n;
  proposal.status = "applied";
  await writeRevisionStore(directory, store);
  return { summary: structuredClone(proposal.article_summary), articleState: proposal.article_state ? structuredClone(proposal.article_state) : undefined, evidenceStateUnavailable: !proposal.article_state, version: n, proposal };
}

export async function discardProposal(directory: string, date: string, articleId: string, proposalId: string) {
  const store = await readRevisionStore(directory, date);
  const proposal = store.articles[articleId]?.proposals.find((item) => item.id === proposalId);
  if (!proposal || proposal.status !== "pending") throw new Error("破棄できる修正案が見つかりません");
  proposal.status = "discarded";
  await writeRevisionStore(directory, store);
  return proposal;
}

export async function revertToVersion(directory: string, date: string, articleId: string, current: SummarizedArticle, target: "initial" | "previous", currentState?: StoredReviewArticleState) {
  const store = await readRevisionStore(directory, date);
  const entry = entryFor(store, articleId, current, currentState);
  const targetNumber = target === "initial" ? 1 : Math.max(1, entry.current_version - 1);
  const source = entry.versions.find((version) => version.n === targetNumber);
  if (!source) throw new Error("戻す元の版が見つかりません");
  assertStateMatchesSummary(source.article_state, source.article_summary, "戻す元の版");
  if (!source.article_state && currentState?.generationMeta?.review_supplements?.length) {
    throw new Error("この旧版は出典履歴がないため、追加根拠を含む現在版から安全に戻せません");
  }
  const n = entry.current_version + 1;
  entry.versions.push({
    n,
    parent: entry.current_version,
    created_at: now(),
    created_by: `revert:${targetNumber}`,
    summary: target === "initial" ? "初稿へ戻す" : "一つ前の版へ戻す",
    article_summary: structuredClone(source.article_summary),
    ...(source.article_state ? { article_state: structuredClone(source.article_state) } : {})
  });
  entry.current_version = n;
  await writeRevisionStore(directory, store);
  return { summary: structuredClone(source.article_summary), articleState: source.article_state ? structuredClone(source.article_state) : undefined, evidenceStateUnavailable: !source.article_state, version: n };
}
