import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordPublication } from "./review/recordPublication.js";
import { selectPublicationCandidates } from "./review/publication.js";
import { prepareXPost } from "./site/prepareXPost.js";
import type { ProcessedArticle } from "./types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-publication-flow-"));
const date = "2026-09-03";
const dataDir = path.join(root, "data");
const outputDir = path.join(root, "output");
const dayDir = path.join(dataDir, date);

try {
  await fs.mkdir(dayDir, { recursive: true });
  await writeState([
    reviewArticle(1, "approved", { slug: "1", published_at: "2026-09-03T09:00:00+08:00", published_version: 1 }),
    reviewArticle(2, "held", { slug: "2" })
  ]);
  await writeRevisions({
    [articleId(1)]: versions(1, "初稿A"),
    [articleId(2)]: versions(1, "初稿B")
  });
  assert.deepEqual((await select()).map((item) => item.slug), ["1"], "approved + held はapprovedだけ公開する");

  await writeState([
    reviewArticle(1, "approved", { slug: "1", published_at: "2026-09-03T09:00:00+08:00", published_version: 1 }),
    reviewArticle(2, "pending", { slug: "2" })
  ]);
  assert.deepEqual((await select()).map((item) => item.slug), ["1"], "approved + pending はapprovedだけ公開する");

  await writeState([reviewArticle(1, "approved", { slug: "queued-only", queued_at: "2026-09-03T09:30:00+08:00" })]);
  await writeRevisions({ [articleId(1)]: versions(1, "公開前の承認版") });
  assert.equal((await select()).length, 0, "通常のmain push buildは公開記録前の承認版を出さない");
  assert.deepEqual((await select({ includeQueued: true })).map((item) => item.slug), ["queued-only"], "review-applyのstaged buildだけ公開前の承認版を含める");

  await writeState([
    reviewArticle(1, "approved", { slug: "1", published_at: "2026-09-03T09:00:00+08:00", published_version: 1 }),
    reviewArticle(2, "held", { slug: "2" })
  ]);
  await recordPublication(dataDir, outputDir, date, "2026-09-03T10:00:00+08:00");
  const later = await readState();
  later.articles[1].status = "approved";
  await fs.writeFile(path.join(dayDir, "review.json"), `${JSON.stringify(later, null, 2)}\n`, "utf8");
  const laterPublication = await recordPublication(dataDir, outputDir, date, "2026-09-03T11:00:00+08:00");
  assert.deepEqual(laterPublication.batch.articles.map((item) => item.slug), ["2"], "保留後に承認しても予約済みslugを変えない");
  assert.equal(laterPublication.batch.articles[0].first_publication, true, "初回公開だけをX候補として記録する");

  await writeState([reviewArticle(1, "proposal_pending", { slug: "stable-a", published_at: "2026-09-03T09:00:00+08:00", published_version: 1 }, 2)]);
  await writeRevisions({ [articleId(1)]: { current_version: 2, versions: [{ n: 1, article_summary: summary("公開版") }, { n: 2, article_summary: summary("修正版") }] } });
  let selected = await select();
  assert.equal(selected[0].slug, "stable-a", "公開済み記事のURLは修正中も固定する");
  assert.equal(selected[0].article.summary?.title_ja, "公開版", "修正中は公開済みversionを表示する");
  const approved = await readState();
  approved.articles[0].status = "approved";
  await fs.writeFile(path.join(dayDir, "review.json"), `${JSON.stringify(approved, null, 2)}\n`, "utf8");
  selected = await select();
  assert.equal(selected[0].slug, "stable-a", "再承認後もURLを変えない");
  assert.equal(selected[0].article.summary?.title_ja, "公開版", "通常のmain push buildは再承認済みでも前回公開版を維持する");
  selected = await select({ includeQueued: true });
  assert.equal(selected[0].article.summary?.title_ja, "修正版", "再承認後はcurrent versionを表示する");
  const correction = await recordPublication(dataDir, outputDir, date, "2026-09-03T11:30:00+08:00");
  const correctedState = await readState();
  assert.equal(correction.batch.articles[0].first_publication, false, "公開済み記事の訂正は再告知候補にしない");
  assert.equal(correctedState.articles[0].publication?.published_at, "2026-09-03T09:00:00+08:00", "訂正しても初回公開時刻を上書きしない");
  assert.equal(correctedState.articles[0].publication?.updated_at, "2026-09-03T11:30:00+08:00", "訂正時刻を別に記録する");

  await writeState([reviewArticle(1, "approved", { slug: "1" })]);
  await writeRevisions({ [articleId(1)]: versions(1, "初稿A") });
  const first = await recordPublication(dataDir, outputDir, date, "2026-09-03T12:00:00+08:00");
  const afterFirst = await fs.readFile(path.join(dayDir, "review.json"), "utf8");
  const second = await recordPublication(dataDir, outputDir, date, "2026-09-03T12:01:00+08:00");
  const afterSecond = await fs.readFile(path.join(dayDir, "review.json"), "utf8");
  assert.equal(first.batch.articles.length, 1, "初回は公開を記録する");
  assert.equal(second.batch.articles.length, 0, "recordPublicationの二重実行は新規0件");
  assert.equal(afterSecond, afterFirst, "二重実行はreview stateを変更しない");
  assert.equal((await readState()).articles[0].publication?.x_pending_at, "2026-09-03T12:00:00+08:00", "初回公開だけを耐久Xキューへ入れる");
  const prepared = await prepareXPost(dataDir, date, "2026-09-03T12:01:30+08:00");
  assert.deepEqual(prepared.articleIds, [articleId(1)], "live X APIの前に投稿試行を永続化する");
  assert.equal((await prepareXPost(dataDir, date, "2026-09-03T12:01:31+08:00")).articleIds.length, 0, "未確定の試行は自動で二重送信しない");

  const state = await readState();
  state.articles[0].publication!.x_posted_at = "2026-09-03T12:02:00+08:00";
  await fs.writeFile(path.join(dayDir, "review.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dayDir, `articles_${date}.json`), JSON.stringify([article("現行A")]), "utf8");
  await fs.writeFile(path.join(outputDir, `publication_batch_${date}.json`), JSON.stringify({ date, articles: [{ article_id: articleId(1), first_publication: true }] }), "utf8");
  execFileSync(process.execPath, ["--import", "tsx", "src/site/postToX.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, REVIEW_GATE: "true", SITE_DATA_DIR: dataDir, SITE_OUTPUT_DIR: outputDir, POST_DATE: date, SITE_URL: "https://example.test" },
    stdio: "pipe"
  });
  const postText = await fs.readFile(path.join(outputDir, `x_posts_${date}.md`), "utf8");
  assert.match(postText, /未投稿の自動X投稿対象がありません/u, "既投稿article_idは再投稿候補から除外する");
  await fs.rm(path.join(outputDir, `publication_batch_${date}.json`));
  const withoutBatch = await runPostToX({});
  assert.match(withoutBatch, /未投稿の自動X投稿対象がありません/u, "review-gatedのbatchなし再実行は安全に停止する");
  const reannouncement = await runPostToX({ X_REANNOUNCE: "true" });
  assert.match(reannouncement, /日次ダイジェスト/u, "明示的な再告知だけはbatchなしでも候補を生成する");
  await fs.writeFile(path.join(outputDir, `publication_batch_${date}.json`), JSON.stringify({ date, recorded_at: "2026-09-10T09:00:00+08:00", articles: [{ article_id: articleId(1), first_publication: false }] }), "utf8");
  const correctionReannouncement = await runPostToX({ X_REANNOUNCE: "true" });
  assert.match(correctionReannouncement, /日次ダイジェスト/u, "明示的な再告知は公開後訂正batchも対象にできる");
  assert.match(correctionReannouncement, /🧊 今日の中国エンタメ｜9\/10/u, "X見出しは公開batchの日時を使う");
  assert.match(correctionReannouncement, new RegExp(`/archive/${date}/`), "Xリンクは生成日アーカイブを維持する");

  const workflow = await fs.readFile(".github/workflows/review-apply.yml", "utf8");
  assert.match(workflow, /if: steps\.review\.outputs\.publish_required == 'true'/u, "公開はcompletedでなくpublish_requiredを使う");
  assert.ok(workflow.indexOf("Deploy production site to Lolipop") < workflow.indexOf("Record daily publication"), "公開記録は本番deploy成功後");
  assert.ok(workflow.indexOf("Record daily publication") < workflow.indexOf("Generate approved X texts"), "X文面は公開記録後");
  assert.match(workflow, /Close completed review issue\r?\n\s+if: steps\.review\.outputs\.completed == 'true'/u, "completedはIssue closeにだけ使う");
  assert.match(workflow, /Prepare live X posting attempt/u, "X API前に耐久試行記録を作る");
  assert.match(workflow, /x_post_required/u, "公開後に残ったXキューも再実行対象にする");
  assert.match(workflow, /X_POST_ATTEMPT_CONFIRMED/u, "永続化済み試行は同一workflowだけが自動実行できる");
  console.log("publication flow: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function select(options: { includeQueued?: boolean } = {}) {
  return (await selectPublicationCandidates(dayDir, [article("現行A"), article("現行B")], options)) ?? [];
}

function articleId(index: number) {
  return `article-${index}`;
}

function reviewArticle(index: number, status: string, publication: Record<string, unknown>, currentVersion = 1) {
  return { index, topic_key: `topic-${index}`, title: `記事${index}`, status, reason_tag: "", comment: "", revision_count: 0, article_id: articleId(index), current_version: currentVersion, publication };
}

function summary(title_ja: string) {
  return { title_ja };
}

function versions(n: number, title: string) {
  return { current_version: n, versions: [{ n, article_summary: summary(title) }] };
}

function article(title: string): ProcessedArticle {
  return {
    raw: { title, url: "https://example.test/source", sourceName: "Example", sourceUrl: "https://example.test/source", category: "test", reliability: "B" },
    summary: summary(title) as ProcessedArticle["summary"]
  };
}

async function writeState(articles: ReturnType<typeof reviewArticle>[]) {
  await fs.writeFile(path.join(dayDir, "review.json"), `${JSON.stringify({ date, status: "pending", issue_number: 1, articles }, null, 2)}\n`, "utf8");
}

async function writeRevisions(articles: Record<string, unknown>) {
  await fs.writeFile(path.join(dayDir, "revisions.json"), `${JSON.stringify({ version: 1, date, articles }, null, 2)}\n`, "utf8");
}

async function readState() {
  return JSON.parse(await fs.readFile(path.join(dayDir, "review.json"), "utf8")) as { articles: Array<ReturnType<typeof reviewArticle>> };
}

async function runPostToX(extraEnv: Record<string, string>) {
  execFileSync(process.execPath, ["--import", "tsx", "src/site/postToX.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, REVIEW_GATE: "true", SITE_DATA_DIR: dataDir, SITE_OUTPUT_DIR: outputDir, POST_DATE: date, SITE_URL: "https://example.test", ...extraEnv },
    stdio: "pipe"
  });
  return fs.readFile(path.join(outputDir, `x_posts_${date}.md`), "utf8");
}
