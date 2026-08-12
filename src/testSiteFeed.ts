import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

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
  const manualDate = "2026-08-02";
  const manualDirectory = path.join(dataRoot, "manual-intake", "987654321");
  await fs.mkdir(manualDirectory, { recursive: true });
  await fs.writeFile(path.join(manualDirectory, "intake-state.json"), JSON.stringify({
    version: 1,
    comment_id: "987654321",
    source_url: "https://example.com/manual",
    note: "速報",
    status: "published",
    published_date: manualDate
  }, null, 2), "utf8");
  await fs.writeFile(path.join(manualDirectory, `articles_${manualDate}.json`), JSON.stringify([fixtureArticle(3)], null, 2), "utf8");
  await fs.writeFile(path.join(manualDirectory, "review.json"), JSON.stringify({
    date: manualDate,
    status: "completed",
    issue_number: 123,
    articles: [{ index: 1, topic_key: "fixture-3", title: "手動フィクスチャ", status: "approved", reason_tag: "", comment: "", revision_count: 0 }]
  }, null, 2), "utf8");

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
  const manualPostOutput = path.join(tempRoot, "manual-post-output");
  execFileSync(process.execPath, ["--import", "tsx", "src/site/manualXPost.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SITE_DATA_DIR: dataRoot,
      SITE_OUTPUT_DIR: manualPostOutput,
      SITE_URL: "https://example.test",
      MANUAL_COMMENT_ID: "987654321",
      MANUAL_PUBLISHED_DATE: manualDate
    },
    stdio: "pipe"
  });

  const home = await readPage("index.html");
  const daily = await readPage(`archive/${date}/index.html`);
  const detail = await readPage(`t/${date}/1/index.html`);
  const detailSecond = await readPage(`t/${date}/2/index.html`);
  const manualDetail = await readPage(`t/${manualDate}/m-987654321/index.html`);
  const manualPost = await fs.readFile(path.join(manualPostOutput, "manual_x_post_987654321.md"), "utf8");
  const about = await readPage("about/index.html");
  const archive = await readPage("archive/index.html");
  const htaccess = await readPage(".htaccess");
  const xCardTestA = await readPage("x-card-test/a/index.html");
  const xCardTestB = await readPage("x-card-test/b/index.html");
  const xCardTestC = await readPage("x-card-test/c/index.html");
  const articleOgpPath = path.join(outputRoot, "og", date, "1.png");
  const articleOgp = await sharp(articleOgpPath).metadata();
  const defaultOgp = await sharp(path.join(outputRoot, "assets", "ogp-default.png")).metadata();
  const homeOgp = await sharp(path.join(outputRoot, "og", "home.png")).metadata();
  const archiveOgp = await sharp(path.join(outputRoot, "og", "archive.png")).metadata();
  const aboutOgp = await sharp(path.join(outputRoot, "og", "about.png")).metadata();
  const xCardTestJpeg = await sharp(path.join(outputRoot, "x-card-test", "fixture.jpg")).metadata();
  const xCardTestPng = await sharp(path.join(outputRoot, "x-card-test", "fixture.png")).metadata();

  assertIncludes(home, "最終更新：2026年8月2日", "トップの日付ラベル");
  assertIncludes(home, "8月2日のピックアップ", "持ち込み承認日をフィード見出しに使う");
  assertIncludes(home, "8月1日のピックアップ", "通常記事のフィード見出しを維持する");
  assertIncludes(home, "参考記事公開日：2026/8/1", "カードの日付は参考記事公開日として示す");
  assertNotIncludes(home, "<details", "トップの折りたたみ");
  assertNotIncludes(home, "<summary", "トップの折りたたみ見出し");
  assertIncludes(home, "フィクスチャ本文 A", "トップの本文全文");
  assertCount(home, "twitter.com/intent/tweet?url=", 3, "トップのカードごとのシェアリンク");
  assertCount(home, 'target="_blank" rel="noopener noreferrer">Xでシェア', 3, "トップのシェアリンクの新規タブ属性");
  assertIncludes(home, '<meta property="og:image" content="https://example.test/og/home.png?v=', "トップ専用OGP画像の絶対URL");
  assertIncludes(home, '<meta property="og:image:width" content="1200">', "共通OGP画像の幅");
  assertIncludes(home, '<meta property="og:image:height" content="630">', "共通OGP画像の高さ");
  assertIncludes(home, '<meta name="twitter:card" content="summary_large_image">', "Xカード形式");
  assertIncludes(home, '<meta name="twitter:image" content="https://example.test/og/home.png?v=', "トップのXカード画像の絶対URL");
  assertIncludes(archive, '<meta property="og:image" content="https://example.test/og/archive.png?v=', "アーカイブ専用OGP画像の絶対URL");
  assertIncludes(archive, '<meta name="twitter:image" content="https://example.test/og/archive.png?v=', "アーカイブのXカード画像の絶対URL");
  assertIncludes(about, '<meta property="og:image" content="https://example.test/og/about.png?v=', "このサイトについて専用OGP画像の絶対URL");
  assertIncludes(about, '<meta name="twitter:image" content="https://example.test/og/about.png?v=', "このサイトについてのXカード画像の絶対URL");
  assertIncludes(home, "/assets/bingtang-logo-horizontal.png", "本番横長ロゴ");
  assertIncludes(home, "/assets/bingtang-hero-v2.png", "本番ヘッダーキャラクター");
  assertNotIncludes(home, "中国エンタメの現地温度を、日本語で。", "削除したキャッチコピー");
  assertNotIncludes(home, "今日のわたしが気になる", "削除した吹き出し文言");
  assertNotIncludes(home, "ビンタンちゃんデイリー", "旧サイト読み");
  assertNotIncludes(home, "確度B", "確度ラベル");
  assertNotIncludes(home, ">本日<", "鮮度ラベル");
  assertIncludes(home, "family=Kosugi+Maru&family=Zen+Kaku+Gothic+New", "タイトルと本文のWebフォント");
  assertIncludes(home, 'class="section-icon section-icon-source"', "ソース構成のアイコン");
  assertIncludes(home, 'class="section-icon section-icon-event"', "何が起きたのアイコン");
  assertIncludes(home, 'class="section-icon section-icon-reaction"', "反応・見られ方のアイコン");
  assertIncludes(home, 'class="section-icon section-icon-point"', "注目ポイントのアイコン");
  assertIncludes(home, 'class="section-icon section-icon-supplement"', "補足のアイコン");
  assertCount(home, "ビンタンからの補足", 3, "トップの補足ラベル");
  assertCount(home, "反応・見られ方", 1, "反応・見られ方は値がある記事だけに表示");
  assertCount(home, "関連角度のソース", 1, "関連角度のソースは使用した記事だけに表示する");
  assertIncludes(home, "関連媒体", "関連角度の媒体を別表示する");
  assertIncludes(home, "/assets/bingtang-avatar-serious-", "訃報記事の真剣な表情");
  assertCount(home, '<span class="avatar avatar-comment">', 3, "注目ポイントだけに出す専用アバター");
  assertNotIncludes(home, "bingtang-avatar-focus.png", "補足用の旧アバター");
  assertIncludes(home, '<section class="bingtang-supplement">\n    <div>', "補足ブロックは顔なし");
  assertNotIncludes(home, "<h2><a href=", "トップから個別ページへのタイトル導線");
  assertCount(daily, "twitter.com/intent/tweet?url=", 2, "日次フィードのカードごとのシェアリンク");
  assertCount(daily, 'target="_blank" rel="noopener noreferrer">Xでシェア', 2, "日次フィードのシェアリンクの新規タブ属性");
  assertCount(daily, "ビンタンからの補足", 2, "日次フィードの補足ラベル");
  assertNotIncludes(detail, "Xでシェア", "個別ページのシェアUI");
  assertNotIncludes(detail, "<nav class=\"article-nav\"", "個別ページの前後記事導線");
  assertNotIncludes(detail, "前の記事", "個別ページの前記事導線");
  assertNotIncludes(detail, "次の記事", "個別ページの次記事導線");
  assertIncludes(detail, "ビンタンからの補足", "個別ページの補足ラベル");
  assertIncludes(detail, "関連角度のソース", "個別ページでも関連角度を別表示する");
  assertNotIncludes(detail, "/assets/bingtang-avatar-serious-", "通常記事に真剣な表情を固定しない");
  assertIncludes(detailSecond, "/assets/bingtang-avatar-serious-", "訃報記事は真剣な表情に固定");
  assertNotIncludes(detail, "bingtang-avatar-focus.png", "個別ページの補足アバター");
  assertIncludes(about, "/assets/bingtang-about-fullbody.png", "サイト紹介専用の全身イラスト");
  assertIncludes(about, "はじめまして、中国エンタメニュース収集担当のAI、冰糖（ビンタン）です。", "FIX済みのビンタン紹介文");
  assertNotIncludes(about, "中国エンタメニュース収集担当AI", "FIX前と異なる肩書き表現");
  assertIncludes(about, "私が集めた情報の中から", "ビンタン自身が収集している説明");
  assertIncludes(about, "運営者はニュース選定方針の設計とサイト運用を行い、必要に応じて記事の確認や修正をしています。", "運営者の役割");
  assertIncludes(about, "人間が裏取りや個別の事実確認を行っているわけではありません。", "個別の事実確認に関する免責");
  assertIncludes(about, "公式発表、現地媒体、SNS、データは性質の異なる情報として扱います。", "情報種別の扱い");
  assertIncludes(about, "噂やSNS上の反応は事実と区別し、未確認情報を断定しません。", "未確認情報の扱い");
  assertIncludes(about, "AIによる読み違い、情報の欠落、不正確な記述が含まれる可能性があります。", "AI生成に関する注意書き");
  assertIncludes(about, "情報の正確性、完全性、最新性を保証するものではありません。", "情報保証に関する注意書き");
  assertIncludes(about, 'href="https://x.com/fal48" target="_blank" rel="noopener noreferrer">@fal48</a>', "問い合わせ先Xリンク");
  assertNotIncludes(about, "このサイトの出発点", "承認されていない追加項目");
  assertNotIncludes(about, "記事はAIが収集・生成し、人間が監修しています。", "実態と異なる一律監修表現");
  assertIncludes(home, "記事はAIが収集・生成しています。運営については", "フッターの運営説明");
  assertIncludes(home, '>「このサイトについて」</a>をご覧ください。', "フッターからAboutへのリンク");
  assertNotIncludes(home, "記事はAIが収集・生成し、人間が監修しています。", "フッターの旧監修表現");
  assertIncludes(detail, `<meta property="og:image" content="https://example.test/og/${date}/1.png?v=`, "記事別OGP画像URL");
  assertIncludes(detail, `<meta name="twitter:image" content="https://example.test/og/${date}/1.png?v=`, "記事別Xカード画像URL");
  assertIncludes(htaccess, "AddDefaultCharset UTF-8", "HTTP文字コード指定");
  assertIncludes(xCardTestA, '<link rel="canonical" href="https://example.test/x-card-test/a/">', "Aの自己参照canonical");
  assertIncludes(xCardTestA, '<meta property="og:url" content="https://example.test/x-card-test/a/">', "Aの自己参照OG URL");
  assertIncludes(xCardTestA, '<meta name="twitter:card" content="summary">', "Aのsummaryカード");
  assertIncludes(xCardTestA, '<meta property="og:image" content="https://example.test/x-card-test/fixture.jpg">', "AのJPEG画像");
  assertIncludes(xCardTestB, '<link rel="canonical" href="https://example.test/x-card-test/b/">', "Bの自己参照canonical");
  assertIncludes(xCardTestB, '<meta property="og:url" content="https://example.test/x-card-test/b/">', "Bの自己参照OG URL");
  assertIncludes(xCardTestB, '<meta name="twitter:card" content="summary_large_image">', "Bのlarge imageカード");
  assertIncludes(xCardTestB, '<meta property="og:image" content="https://example.test/x-card-test/fixture.jpg">', "BのJPEG画像");
  assertIncludes(xCardTestC, '<link rel="canonical" href="https://example.test/x-card-test/c/">', "Cの自己参照canonical");
  assertIncludes(xCardTestC, '<meta property="og:url" content="https://example.test/x-card-test/c/">', "Cの自己参照OG URL");
  assertIncludes(xCardTestC, '<meta name="twitter:card" content="summary_large_image">', "Cのlarge imageカード");
  assertIncludes(xCardTestC, '<meta property="og:image" content="https://example.test/x-card-test/fixture.png">', "CのPNG画像");
  assertIncludes(manualDetail, `https://example.test/og/${manualDate}/m-987654321.png?v=`, "持ち込み記事の固有OGPとcache bust");
  assertIncludes(manualDetail, "フィクスチャ記事 B", "持ち込み記事の本文");
  assertIncludes(manualPost, `https://example.test/t/${manualDate}/m-987654321/`, "持ち込み公開URL付きX文面");
  if (articleOgp.width !== 1200 || articleOgp.height !== 630) throw new Error(`記事別OGPは1200x630のはずですが ${articleOgp.width}x${articleOgp.height} です`);
  if (defaultOgp.width !== 1200 || defaultOgp.height !== 630) throw new Error(`共通OGPは1200x630のはずですが ${defaultOgp.width}x${defaultOgp.height} です`);
  for (const [name, ogp] of [["トップ", homeOgp], ["アーカイブ", archiveOgp], ["このサイトについて", aboutOgp]] as const) {
    if (ogp.width !== 1200 || ogp.height !== 630) throw new Error(`${name}のOGPは1200x630のはずですが ${ogp.width}x${ogp.height} です`);
  }
  if (xCardTestJpeg.format !== "jpeg" || xCardTestJpeg.width !== 1200 || xCardTestJpeg.height !== 630) throw new Error(`Xカード比較JPEGは1200x630 JPEGのはずですが ${xCardTestJpeg.format} ${xCardTestJpeg.width}x${xCardTestJpeg.height} です`);
  if (xCardTestPng.format !== "png" || xCardTestPng.width !== 1200 || xCardTestPng.height !== 630) throw new Error(`Xカード比較PNGは1200x630 PNGのはずですが ${xCardTestPng.format} ${xCardTestPng.width}x${xCardTestPng.height} です`);

  console.log("site feed: ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function readPage(relativePath: string) {
  return fs.readFile(path.join(outputRoot, relativePath), "utf8");
}

function fixtureArticle(index: number) {
  const suffix = index === 1 ? "A" : "B";
  const category = index === 1 ? "ドラマ" : "訃報";
  const url = `https://example.com/article-${index}`;
  const relatedUrl = `https://example.com/angle-${index}`;
  return {
    raw: {
      title: `フィクスチャ記事 ${suffix}`,
      url,
      sourceName: "テスト媒体",
      sourceUrl: url,
      category,
      reliability: "B",
      sourceType: "media_report"
    },
    summary: {
      title_ja: `フィクスチャ記事 ${suffix}`,
      badge: "NEWS",
      lead: `フィクスチャのリード ${suffix}`,
      what_happened: `フィクスチャ本文 ${suffix}`,
      why_it_matters: `ビンタンの注目ポイント ${suffix}！`,
      reaction_view: index === 1 ? `フィクスチャの反応 ${suffix}` : "",
      editor_comment: "",
      japan_context_note: `日本語読者向けの補足 ${suffix}！`,
      category,
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
      related_sources: index === 1 ? [{ name: "関連媒体", url: relatedUrl }] : [],
      tags: [],
      publish_priority: "medium",
      publish_reason: "fixture",
      claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
    },
    ...(index === 1 ? {
      topic: {
        evidence_articles: [{ url, source_name: "テスト媒体", source_type: "media_report" }],
        related_evidence_articles: [{ url: relatedUrl, source_name: "関連媒体", source_type: "media_report" }]
      }
    } : {})
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
