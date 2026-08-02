import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const date = "2026-08-01";
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-site-feed-"));
const dataRoot = path.join(tempRoot, "data");
const outputRoot = path.join(tempRoot, "site");

try {
  const dayDirectory = path.join(dataRoot, date);
  await fs.mkdir(dayDirectory, { recursive: true });
  await fs.writeFile(
    path.join(dayDirectory, `articles_${date}.json`),
    JSON.stringify([fixtureArticle(1), fixtureArticle(2)], null, 2),
    "utf8"
  );

  execFileSync(process.execPath, ["--import", "tsx", "src/site/build.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      REVIEW_GATE: "false",
      SITE_DATA_DIR: dataRoot,
      SITE_OUTPUT_DIR: outputRoot,
      SITE_URL: "https://example.test",
      SITE_ASSET_DIR: path.join(tempRoot, "missing-assets")
    },
    stdio: "pipe"
  });

  const home = await readPage("index.html");
  const daily = await readPage(`archive/${date}/index.html`);
  const detail = await readPage(`t/${date}/1/index.html`);

  assertIncludes(home, "最終更新：2026年8月1日", "トップの日付ラベル");
  assertNotIncludes(home, "<details", "トップの折りたたみ");
  assertNotIncludes(home, "<summary", "トップの折りたたみ見出し");
  assertIncludes(home, "フィクスチャ本文 A", "トップの本文全文");
  assertCount(home, "twitter.com/intent/tweet?url=", 2, "トップのカードごとのシェアリンク");
  assertCount(home, "ビンタンからの補足", 2, "トップの補足ラベル");
  assertNotIncludes(home, "<h2><a href=", "トップから個別ページへのタイトル導線");
  assertCount(daily, "twitter.com/intent/tweet?url=", 2, "日次フィードのカードごとのシェアリンク");
  assertCount(daily, "ビンタンからの補足", 2, "日次フィードの補足ラベル");
  assertNotIncludes(detail, "Xでシェア", "個別ページのシェアUI");
  assertNotIncludes(detail, "<nav class=\"article-nav\"", "個別ページの前後記事導線");
  assertNotIncludes(detail, "前の記事", "個別ページの前記事導線");
  assertNotIncludes(detail, "次の記事", "個別ページの次記事導線");
  assertIncludes(detail, "ビンタンからの補足", "個別ページの補足ラベル");

  console.log("site feed: ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function readPage(relativePath: string) {
  return fs.readFile(path.join(outputRoot, relativePath), "utf8");
}

function fixtureArticle(index: number) {
  const suffix = index === 1 ? "A" : "B";
  const url = `https://example.com/article-${index}`;
  return {
    raw: {
      title: `フィクスチャ記事 ${suffix}`,
      url,
      sourceName: "テスト媒体",
      sourceUrl: url,
      category: "ドラマ",
      reliability: "B",
      sourceType: "media_report"
    },
    summary: {
      title_ja: `フィクスチャ記事 ${suffix}`,
      badge: "NEWS",
      lead: `フィクスチャのリード ${suffix}`,
      what_happened: `フィクスチャ本文 ${suffix}`,
      why_it_matters: `ビンタンの注目ポイント ${suffix}！`,
      reaction_view: `フィクスチャの反応 ${suffix}`,
      editor_comment: "",
      japan_context_note: `日本語読者向けの補足 ${suffix}！`,
      category: "ドラマ",
      confidence: "B",
      source_type: "media_report",
      published_date: date,
      event_date: date,
      freshness_label: "today",
      newsworthiness_score: 10 - index,
      japan_visibility: "low",
      japan_gap: "high",
      context_value: "high",
      sns_heat: "none",
      source_count: 1,
      source_list: [{ name: "テスト媒体", url }],
      has_official_source: false,
      has_multiple_sources: false,
      has_sns_signal: false,
      article_type: "news_event",
      skip_reason: "",
      verification_status: "verified",
      topic_key: `fixture-${index}`,
      main_entities: { people: [], works: [], organizations: [] },
      related_sources: [{ name: "テスト媒体", url }],
      tags: [],
      publish_priority: "medium",
      publish_reason: "fixture",
      claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
    }
  };
}

function assertIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) throw new Error(`${label} がありません: ${expected}`);
}

function assertNotIncludes(value: string, unexpected: string, label: string) {
  if (value.includes(unexpected)) throw new Error(`${label} が残っています: ${unexpected}`);
}

function assertCount(value: string, expected: string, count: number, label: string) {
  const actual = value.split(expected).length - 1;
  if (actual !== count) throw new Error(`${label} は ${count} 件のはずですが ${actual} 件です`);
}
