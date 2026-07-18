import fs from "node:fs/promises";
import path from "node:path";
import { getPublishableArticles } from "../renderMarkdown.js";
import { resolveSummaryTitle } from "../summaryTitle.js";
import type { ProcessedArticle, ReviewState, SourceRef, SourceTypeLabel, SummarizedArticle } from "../types.js";

type DayData = { date: string; articles: ProcessedArticle[] };
type SourceMix = { official: number; media: number; sns: number; data: number };

const DATA_DIR = path.resolve(process.env.SITE_DATA_DIR || "data");
const OUTPUT_DIR = path.resolve(process.env.SITE_OUTPUT_DIR || "dist/site");
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE_PATH = normalizeBasePath(process.env.SITE_BASE_PATH || "");
const SITE_NAME = "冰糖日报（ビンタンちゃんデイリー）";
const SITE_DESCRIPTION = "中国エンタメの現地温度を、日本語で。";
const ABOUT_PROFILE = "中国エンタメ担当のAI秘書、冰糖（ビンタン）です。中国語圏で実際に観られている・語られているエンタメを、毎朝届く記事の束から選んで日本語でお届けします。モットーは「熱量は拾う。でも断定しない。」です！";
const REVIEW_GATE_ENABLED = process.env.REVIEW_GATE !== "false";

async function main() {
  const days = await loadDays();
  for (const day of days) loadedDayPositions.set(day.date, day.articles);
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await copySiteAssets();

  const nonEmptyDays = days.filter((day) => day.articles.length > 0);
  const newestDate = nonEmptyDays[0]?.date;
  const latest = nonEmptyDays.flatMap((day) => day.articles.map((article) => ({ date: day.date, article }))).slice(0, 10);

  await writePage("index.html", renderLayout({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    canonicalPath: "/",
    currentNav: "latest",
    body: renderHome(latest),
    headerDate: newestDate,
    fullHeader: true
  }));

  for (const day of days) {
    await writePage(`archive/${day.date}/index.html`, renderLayout({
      title: `${formatLongDate(day.date)}｜${SITE_NAME}`,
      description: `${formatLongDate(day.date)}の中国エンタメ情報`,
      canonicalPath: `/archive/${day.date}/`,
      currentNav: "latest",
      body: renderDaily(day),
      headerDate: day.date,
      fullHeader: true
    }));

    await Promise.all(day.articles.map((article, index) => {
      const summary = requireSummary(article);
      const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
      const previous = day.articles[index - 1];
      const next = day.articles[index + 1];
      return writePage(`t/${day.date}/${index + 1}/index.html`, renderLayout({
        title: `${title}｜${SITE_NAME}`,
        description: summary.lead,
        canonicalPath: `/t/${day.date}/${index + 1}/`,
        currentNav: "",
        body: renderArticlePage(day.date, article, index, previous, next),
        fullHeader: false,
        articleDate: day.date
      }));
    }));
  }

  await writePage("archive/index.html", renderLayout({
    title: `アーカイブ｜${SITE_NAME}`,
    description: "冰糖日报の過去記事一覧",
    canonicalPath: "/archive/",
    currentNav: "archive",
    body: renderArchive(days),
    fullHeader: true
  }));
  await writePage("about/index.html", renderLayout({
    title: `このサイトについて｜${SITE_NAME}`,
    description: ABOUT_PROFILE,
    canonicalPath: "/about/",
    currentNav: "about",
    body: renderAbout(),
    fullHeader: true
  }));
  await fs.writeFile(path.join(OUTPUT_DIR, ".nojekyll"), "", "utf8");

  const articleCount = days.reduce((sum, day) => sum + day.articles.length, 0);
  console.log(`site build: ${days.length}日分・${articleCount}記事・${3 + days.length + articleCount}ページ`);
  console.log(`site output: ${OUTPUT_DIR}`);
}

async function loadDays(): Promise<DayData[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`サイト用データがありません: ${DATA_DIR}`);
    }
    throw error;
  }

  const days: DayData[] = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const directory = path.join(DATA_DIR, entry.name);
    const files = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    if (!files.length) continue;
    const raw = JSON.parse(await fs.readFile(path.join(directory, files.at(-1)!), "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${files.at(-1)}: JSONルートは配列である必要があります`);
    const storedArticles = raw.map((item, index) => normalizeStoredArticle(item, entry.name, index));
    const reviewedArticles = REVIEW_GATE_ENABLED ? await filterReviewedArticles(directory, storedArticles) : storedArticles;
    if (reviewedArticles === null) continue;
    const articles = reviewedArticles === storedArticles
      ? getPublishableArticles(reviewedArticles)
      : reviewedArticles.filter((article) => article.summary);
    validateArticles(articles, entry.name);
    days.push({ date: entry.name, articles });
  }
  return days.sort((left, right) => right.date.localeCompare(left.date));
}

async function filterReviewedArticles(directory: string, articles: ProcessedArticle[]): Promise<ProcessedArticle[] | null> {
  let review: ReviewState;
  try {
    review = JSON.parse(await fs.readFile(path.join(directory, "review.json"), "utf8")) as ReviewState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return articles;
    throw error;
  }
  if (review.status !== "completed") return null;
  return review.articles
    .filter((item) => item.status === "approved")
    .map((item) => articles[item.index - 1])
    .filter((article): article is ProcessedArticle => Boolean(article));
}

function normalizeStoredArticle(value: unknown, date: string, index: number): ProcessedArticle {
  if (!value || typeof value !== "object") throw new Error(`${date} #${index + 1}: 記事がオブジェクトではありません`);
  const record = value as Record<string, unknown>;
  if (record.raw && record.summary) return value as ProcessedArticle;
  if (typeof record.title_ja === "string") {
    const summary = value as SummarizedArticle;
    const firstSource = summary.source_list?.[0];
    return {
      raw: {
        title: summary.title_ja,
        url: firstSource?.url || "",
        sourceName: firstSource?.name || "",
        sourceUrl: firstSource?.url || "",
        category: summary.category,
        reliability: summary.confidence
      },
      summary
    };
  }
  throw new Error(`${date} #${index + 1}: ProcessedArticle / SummarizedArticle のどちらでもありません`);
}

function validateArticles(articles: ProcessedArticle[], date: string) {
  articles.forEach((article, index) => {
    const summary = requireSummary(article);
    const sources = getSources(article);
    if (!sources.length) throw new Error(`${date} #${index + 1}: ソース行が空です`);
    for (const source of sources) {
      if (!source.name.trim() || !source.url?.trim()) throw new Error(`${date} #${index + 1}: 全ソースに媒体名とリンクURLが必要です`);
      assertHttpUrl(source.url, `${date} #${index + 1}: 不正なソースURL`);
    }
    if (!resolveSummaryTitle(summary.title_ja, article.raw.title).trim()) throw new Error(`${date} #${index + 1}: タイトルが空です`);
  });
}

function requireSummary(article: ProcessedArticle) {
  if (!article.summary) throw new Error("公開記事にsummaryがありません");
  return article.summary;
}

function getSources(article: ProcessedArticle): Array<{ name: string; url: string }> {
  const summary = requireSummary(article);
  const sources: SourceRef[] = summary.source_list?.length
    ? summary.source_list
    : article.raw.sourceName && article.raw.url
      ? [{ name: article.raw.sourceName, url: article.raw.url }]
      : [];
  return sources.map((source) => ({ name: source.name, url: source.url || "" }));
}

function getSourceMix(article: ProcessedArticle): SourceMix {
  const summary = requireSummary(article);
  const mix = article.topic?.source_mix;
  if (mix) {
    return {
      official: mix.official + mix.pr_like,
      media: mix.media_report + mix.mixed,
      sns: mix.sns + mix.rumor,
      data: mix.data
    };
  }
  return sourceTypeToMix(summary.source_type);
}

function sourceTypeToMix(type: SourceTypeLabel): SourceMix {
  return {
    official: type === "official" || type === "pr_like" ? 1 : 0,
    media: type === "media_report" || type === "mixed" ? 1 : 0,
    sns: type === "sns" || type === "rumor" ? 1 : 0,
    data: type === "data" ? 1 : 0
  };
}

function renderHome(items: Array<{ date: string; article: ProcessedArticle }>) {
  if (!items.length) return `<main class="feed"><section class="empty">この日は記事をお届けできませんでした。収集または生成に失敗したためです。前日までの記事はアーカイブからどうぞ。</section></main>`;
  let lastDate = "";
  const cards = items.map(({ date, article }) => {
    const position = findArticlePosition(date, article);
    const heading = date !== lastDate ? `<h1 class="date-heading"><a href="${href(`/archive/${date}/`)}">${escapeHtml(formatShortDate(date))}</a></h1>` : "";
    lastDate = date;
    return `${heading}${renderCard(date, position, article)}`;
  }).join("");
  return `<main class="feed">${cards}<p class="archive-cta"><a href="${href("/archive/")}">過去の記事はアーカイブへ →</a></p>${renderLegend()}${renderFooterBanner()}</main>`;
}

function findArticlePosition(date: string, article: ProcessedArticle) {
  const day = loadedDayPositions.get(date);
  return day ? day.indexOf(article) + 1 : 1;
}

const loadedDayPositions = new Map<string, ProcessedArticle[]>();

function renderDaily(day: DayData) {
  const content = day.articles.length
    ? day.articles.map((article, index) => renderCard(day.date, index + 1, article)).join("")
    : `<section class="empty">この日は記事をお届けできませんでした。収集または生成に失敗したためです。前日までの記事はアーカイブからどうぞ。</section>`;
  return `<main class="feed"><h1 class="page-title">${escapeHtml(formatLongDate(day.date))}の記事</h1>${content}${renderLegend()}${renderFooterBanner()}</main>`;
}

function renderCard(date: string, position: number, article: ProcessedArticle) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  return `<article class="news-card card-${badgeClass(summary.badge)}">
    <div class="chips">${renderChips(summary)}<time datetime="${escapeAttr(date)}">${escapeHtml(formatNumericDate(summary.event_date || summary.published_date || date))}</time></div>
    <h2><a href="${href(`/t/${date}/${position}/`)}">${escapeHtml(title)}</a></h2>
    <p class="lead clamp-3">${escapeHtml(summary.lead)}</p>
    ${renderSourceMix(article)}
    ${renderBingtangComment(summary.why_it_matters, "feed")}
    ${renderSourceRow(article)}
    <p class="read-more"><a href="${href(`/t/${date}/${position}/`)}">しっかり読む →</a></p>
  </article>`;
}

function renderArticlePage(date: string, article: ProcessedArticle, index: number, previous?: ProcessedArticle, next?: ProcessedArticle) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  const currentUrl = absoluteUrl(`/t/${date}/${index + 1}/`);
  return `<main class="article-page">
    <article>
      <div class="chips">${renderChips(summary)}<time datetime="${escapeAttr(date)}">${escapeHtml(formatNumericDate(summary.event_date || summary.published_date || date))}</time></div>
      <h1>${escapeHtml(title)}</h1>
      <p class="article-lead">${escapeHtml(summary.lead)}</p>
      ${renderSourceMix(article)}
      ${renderTextSection("何が起きた？", summary.what_happened)}
      ${renderBingtangComment(summary.why_it_matters, "detail", summary.editor_comment)}
      ${renderTextSection("反応・見られ方", summary.reaction_view)}
      ${renderTextSection("日本語圏では見えにくいポイント", summary.japan_context_note)}
      <div class="article-actions">${renderSourceRow(article)}<a class="share" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(currentUrl)}&text=${encodeURIComponent(title)}">Xでシェア</a></div>
    </article>
    <nav class="article-nav" aria-label="記事間ナビゲーション">
      ${previous ? articleNavLink(date, index, previous, "← 前の記事") : "<span></span>"}
      <a href="${href(`/archive/${date}/`)}">この日の一覧へ</a>
      ${next ? articleNavLink(date, index + 2, next, "次の記事 →") : "<span></span>"}
    </nav>
  </main>`;
}

function articleNavLink(date: string, position: number, article: ProcessedArticle, label: string) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  return `<a href="${href(`/t/${date}/${position}/`)}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(title)}</small></a>`;
}

function renderChips(summary: SummarizedArticle) {
  const freshness = freshnessLabel(summary.freshness_label);
  return `<span class="chip badge badge-${badgeClass(summary.badge)}">${escapeHtml(summary.badge)}</span>
    <span class="chip category">${escapeHtml(summary.category)}</span>
    <span class="chip confidence confidence-${escapeAttr(summary.confidence)}">確度${escapeHtml(summary.confidence)}</span>
    <span class="chip freshness freshness-${escapeAttr(summary.freshness_label)}">${escapeHtml(freshness)}</span>`;
}

function renderSourceMix(article: ProcessedArticle) {
  const mix = getSourceMix(article);
  const officialOnly = mix.official > 0 && mix.media + mix.sns + mix.data === 0;
  return `<div class="source-mix"><strong>ソース構成</strong>
    ${pip("official", "公式", mix.official)}${pip("media", "媒体", mix.media)}${pip("sns", "SNS", mix.sns)}${pip("data", "データ", mix.data)}
    ${officialOnly ? `<span class="official-warning">⚠ 公式発表のみ・裏付けなし</span>` : ""}
  </div>`;
}

function pip(kind: string, label: string, count: number) {
  return `<span class="pip${count === 0 ? " zero" : ""}"><i class="pip-${kind}"></i>${label} ${count}</span>`;
}

function renderBingtangComment(main: string, mode: "feed" | "detail", closing = "") {
  if (!main && !closing) return "";
  return `<section class="bingtang-comment ${mode === "feed" ? "clamp-4" : ""}">
    ${renderAvatar("avatar-36")}
    <div><h3>ビンタンの注目ポイント</h3>${main ? `<p>${escapeHtml(main)}</p>` : ""}${closing ? `<hr><p>${escapeHtml(closing)}</p>` : ""}</div>
  </section>`;
}

function renderTextSection(title: string, text: string) {
  return text ? `<section class="article-section"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>` : "";
}

function renderSourceRow(article: ProcessedArticle) {
  return `<p class="sources"><strong>ソース:</strong> ${getSources(article).map((source) => `<a href="${escapeAttr(source.url)}" rel="noopener noreferrer">${escapeHtml(source.name)}</a>`).join("、")}</p>`;
}

function renderArchive(days: DayData[]) {
  const list = days.length
    ? days.map((day) => `<li><a href="${href(`/archive/${day.date}/`)}"><time datetime="${day.date}">${escapeHtml(formatLongDate(day.date))}</time><span>${day.articles.length}本</span></a></li>`).join("")
    : "<li>アーカイブはまだありません。</li>";
  return `<main class="narrow"><h1 class="page-title">アーカイブ</h1><ul class="archive-list">${list}</ul></main>`;
}

function renderAbout() {
  return `<main class="narrow about"><h1 class="page-title">このサイトについて</h1>
    <section class="profile">${renderAvatar("avatar-64")}<p>${escapeHtml(ABOUT_PROFILE)}</p></section>
    <section><h2>冰糖日报について</h2><p>このサイトは、中国語記事を日本語に翻訳・要約するだけのニュースサイトではありません。中国現地で実際に評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋めることを目的にしています。</p></section>
    <section><h2>情報の扱い</h2><ul><li>熱搜は真実ではなく、現地の温度を測る手がかりとして扱います。</li><li>公式発表は事実確認に使いますが、中立な説明とは限らないものとして読みます。</li><li>噂や未確認情報は事実と分け、存在しない反応や背景を作りません。</li><li>各記事に参照したソースと、公式・媒体・SNS・データの構成を表示します。</li></ul></section>
    <section><h2>AIと人間の役割</h2><p>記事はAIが収集・生成し、人間が監修しています。AI秘書のビンタンは、確認できたことと、まだ言えないことの境界を意識しながら注目ポイントをお届けします。</p></section>
  </main>`;
}

function renderLegend() {
  return `<aside class="legend"><h2>表示の見方</h2><p><span class="chip badge badge-news">NEWS</span> 報道　<span class="chip badge badge-official">OFFICIAL</span> 公式　<span class="chip badge badge-data">DATA</span> データ</p><p><span class="chip confidence confidence-A">確度A</span>〜<span class="chip confidence confidence-C">確度C</span> は根拠の確認度です。 ${pip("official", "公式", 1)}${pip("media", "媒体", 1)}${pip("sns", "SNS", 1)}${pip("data", "データ", 1)}</p><p><span class="official-warning">⚠ 公式発表のみ・裏付けなし</span> は、独立した報道や反応をまだ確認できていない記事です。</p></aside>`;
}

function renderFooterBanner() {
  return `<aside class="footer-banner">${renderAvatar("avatar-48")}<p>気になるニュースは「しっかり読む」から全文をどうぞ。過去の記事はアーカイブにありますよ！</p><a href="${href("/about/")}">このサイトについて →</a></aside>`;
}

function renderAvatar(sizeClass: string) {
  return `<span class="avatar ${sizeClass}"><img src="${href("/assets/bingtang-avatar.png")}" alt="ビンタン（AI秘書）" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="avatar-fallback" hidden aria-hidden="true">🧊</span></span>`;
}

function renderLayout(options: { title: string; description: string; canonicalPath: string; currentNav: "latest" | "archive" | "about" | ""; body: string; fullHeader: boolean; headerDate?: string; articleDate?: string }) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title><meta name="description" content="${escapeAttr(options.description)}"><link rel="canonical" href="${absoluteUrl(options.canonicalPath)}"><meta property="og:type" content="${options.fullHeader ? "website" : "article"}"><meta property="og:title" content="${escapeAttr(options.title)}"><meta property="og:description" content="${escapeAttr(options.description)}"><meta property="og:url" content="${absoluteUrl(options.canonicalPath)}"><meta property="og:image" content="${absoluteUrl("/assets/ogp-default.png")}"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="${href("/assets/favicon-32.png")}"><style>${CSS}</style></head><body>
  ${options.fullHeader ? renderHeader(options.currentNav, options.headerDate) : renderArticleHeader(options.articleDate || "")}
  ${options.body}${renderFooter()}</body></html>`;
}

function renderHeader(current: "latest" | "archive" | "about" | "", date?: string) {
  return `<header class="hero"><div class="hero-inner"><div class="brand"><a href="${href("/")}" class="logo"><span>冰糖</span><b>日报</b></a><span class="subtitle">ビンタンちゃんデイリー</span><p>中国エンタメの<span>現地温度</span>を、日本語で。</p>${date ? `<time class="date-badge" datetime="${date}">${escapeHtml(formatLongDate(date))}</time>` : ""}</div><div class="hero-character"><p>今日のわたしが気になる中国エンタメ情報です！</p><span class="bust"><img src="${href("/assets/bingtang-bust.png")}" alt="ビンタン（AI秘書）" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden class="bust-fallback" aria-hidden="true">🧊</span></span></div></div>${renderNav(current)}</header>`;
}

function renderNav(current: "latest" | "archive" | "about" | "") {
  return `<nav class="main-nav"><a${current === "latest" ? " class=\"current\"" : ""} href="${href("/")}">最新</a><a${current === "archive" ? " class=\"current\"" : ""} href="${href("/archive/")}">アーカイブ</a><a${current === "about" ? " class=\"current\"" : ""} href="${href("/about/")}">このサイトについて</a></nav>`;
}

function renderArticleHeader(date: string) {
  return `<header class="article-header"><a href="${href("/")}" class="mini-logo"><span>冰糖</span><b>日报</b></a><a href="${href(`/archive/${date}/`)}">← ${escapeHtml(date)} の一覧へ</a></header>`;
}

function renderFooter() {
  return `<footer class="site-footer"><p>冰糖日报（ビンタンちゃんデイリー）／記事はAIが収集・生成し、人間が監修しています／© 2026 冰糖日报</p><nav><a href="${href("/about/")}">このサイトについて</a><a href="${href("/archive/")}">アーカイブ</a></nav></footer>`;
}

function badgeClass(badge: string) {
  if (badge === "OFFICIAL" || badge === "PR WATCH") return "official";
  if (badge === "DATA") return "data";
  return "news";
}

function freshnessLabel(label: string) {
  return ({ today: "本日", yesterday: "昨日", recent: "数日内", stale: "旧聞", old: "旧聞", background: "背景", unknown: "時期不明" } as Record<string, string>)[label] || "時期不明";
}

function formatLongDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(parsed).replace(/\((.)\)$/, "（$1）");
}

function formatShortDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(parsed).replace(/\((.)\)$/, "（$1）");
}

function formatNumericDate(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : date;
}

function parseDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`不正な日付: ${date}`);
  return new Date(`${date}T12:00:00+08:00`);
}

function normalizeBasePath(value: string) {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function href(sitePath: string) {
  return `${BASE_PATH}${sitePath.startsWith("/") ? sitePath : `/${sitePath}`}` || "/";
}

function absoluteUrl(sitePath: string) {
  return `${SITE_URL}${href(sitePath)}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function assertHttpUrl(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label}: ${value}`);
}

async function writePage(relativePath: string, contents: string) {
  const outputPath = path.join(OUTPUT_DIR, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, contents, "utf8");
}

async function copySiteAssets() {
  const sourceDir = path.resolve(process.env.SITE_ASSET_DIR || "docs/assets/site");
  const destination = path.join(OUTPUT_DIR, "assets");
  try {
    await fs.access(sourceDir);
    await fs.cp(sourceDir, destination, { recursive: true });
  } catch {
    console.warn(`site assets: ${sourceDir} が未配置のため、ブラウザでは🧊 fallbackを使用します`);
  }
}

const CSS = String.raw`
:root{--bt-ice:#A7CDDF;--bt-red:#C12B23;--bt-amber:#CD7019;--bt-navy:#1F3043;--bt-ivory:#F0E6DA;--bt-ice-50:#F6FAFC;--bt-ice-100:#EAF4FA;--bt-ice-200:#DEEEF6;--bt-ice-600:#4E8FAE;--bt-red-dark:#A32017;--bt-amber-50:#FBF1E2;--bt-amber-900:#7A4A10;--bt-text:#2A3948;--bt-muted:#6E7E8C;--bt-border:#DCE8EF;--bt-card:#FFF;--bt-silver:#9AA7B1;--bt-gray:#C2CBD2}
*{box-sizing:border-box}html{overflow-x:hidden;background:var(--bt-ice-50);color:var(--bt-text);font-family:"Hiragino Maru Gothic ProN","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;font-size:16px}body{margin:0;overflow-x:hidden;line-height:1.85}a{color:var(--bt-red);text-decoration:none}a:hover{text-decoration:underline;color:var(--bt-red-dark)}.hero{background:var(--bt-ice-200);border-bottom:1px solid var(--bt-border)}.hero-inner{max-width:1080px;min-height:220px;margin:auto;padding:24px 32px 0;display:flex;align-items:center;justify-content:space-between}.brand{padding-bottom:24px}.logo,.mini-logo{font-weight:900;letter-spacing:.04em}.logo{display:block;font-size:1.6rem;line-height:1.25}.logo span,.mini-logo span{color:var(--bt-navy)}.logo b,.mini-logo b{color:var(--bt-red)}.subtitle{display:block;color:var(--bt-red);font-size:.8rem;font-weight:700}.brand p{color:var(--bt-muted);font-size:.85rem}.brand p span{color:var(--bt-red)}.date-badge{display:inline-block;background:#fff;border:1px solid var(--bt-border);border-radius:999px;padding:4px 12px;font-size:.78rem}.hero-character{height:200px;display:flex;align-items:center;gap:12px}.hero-character>p{position:relative;max-width:220px;margin:0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:12px 16px;font-size:.85rem;font-weight:700;color:var(--bt-navy)}.bust{width:190px;height:200px;display:grid;place-items:end center;overflow:hidden}.bust img{max-width:100%;height:200px;object-fit:contain;object-position:bottom}.bust-fallback{width:150px;height:150px;border-radius:50%;background:var(--bt-ice);display:grid;place-items:center;font-size:64px;margin-bottom:16px}.main-nav{height:52px;background:#fff;display:flex;align-items:center;justify-content:center;gap:42px}.main-nav a{height:52px;padding:12px 4px;color:var(--bt-navy);font-weight:700}.main-nav a.current{border-bottom:2px solid var(--bt-red);color:var(--bt-red)}.feed{width:min(820px,calc(100% - 28px));margin:36px auto}.date-heading{text-align:center;font-size:1.2rem;margin:40px 0 20px}.date-heading a{color:var(--bt-navy)}.page-title{color:var(--bt-navy);font-size:1.45rem;margin:0 0 28px}.news-card{position:relative;background:var(--bt-card);border:1px solid var(--bt-border);border-radius:14px;box-shadow:0 1px 3px rgba(31,48,67,.08);padding:22px 20px 18px;margin-bottom:20px;overflow:hidden}.news-card:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--bt-red)}.news-card.card-official:before{background:var(--bt-navy)}.news-card.card-data:before{background:var(--bt-ice-600)}.chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.chips time{margin-left:auto;color:var(--bt-muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.chip{display:inline-flex;align-items:center;min-height:27px;border-radius:999px;padding:2px 10px;font-size:.75rem;font-weight:700;line-height:1.4}.badge{color:#fff}.badge-news{background:var(--bt-red)}.badge-official{background:var(--bt-navy)}.badge-data{background:var(--bt-ice-600)}.category{background:var(--bt-ivory);color:var(--bt-navy)}.confidence{background:#fff;border:1.5px solid var(--bt-gray);color:var(--bt-muted)}.confidence-A{border-color:var(--bt-amber);color:var(--bt-amber-900)}.confidence-B{border-color:var(--bt-silver);color:#5F6E79}.freshness{border-radius:5px;background:#fff;border:1px solid var(--bt-red);color:var(--bt-red)}.freshness-today{background:var(--bt-red);color:#fff}.news-card h2{font-size:1.08rem;line-height:1.6;margin:14px 0 8px}.news-card h2 a{color:var(--bt-navy)}.lead{font-size:.92rem;margin:0 0 14px}.clamp-3{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.source-mix{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#FAF8F5;border-radius:10px;padding:8px 12px;color:var(--bt-muted);font-size:.78rem}.source-mix strong{margin-right:2px}.pip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.pip.zero{opacity:.4}.pip i{width:9px;height:9px;border-radius:50%;background:var(--bt-navy)}.pip i.pip-media{background:var(--bt-red)}.pip i.pip-sns{background:var(--bt-amber)}.pip i.pip-data{background:var(--bt-ice-600)}.official-warning{display:inline-flex;border:1px solid #E8CFA4;border-radius:6px;background:var(--bt-amber-50);color:var(--bt-amber-900);font-size:.76rem;font-weight:700;padding:4px 8px}.bingtang-comment{display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px;margin:16px 0 12px;background:var(--bt-ice-100);border:1px solid var(--bt-ice);border-radius:4px 14px 14px;padding:14px}.bingtang-comment h3{color:var(--bt-red);font-size:.9rem;line-height:1.4;margin:0 0 6px}.bingtang-comment p{margin:0;font-size:.88rem;line-height:1.8}.bingtang-comment hr{border:0;border-top:1px solid var(--bt-ice);margin:14px 0}.bingtang-comment.clamp-4>div{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}.avatar{flex:none;display:inline-grid;border-radius:50%;overflow:hidden;background:var(--bt-ice);border:2px solid var(--bt-ice);place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}.avatar-fallback{display:grid;place-items:center;width:100%;height:100%;font-size:.55em}.avatar-36{width:36px;height:36px;font-size:24px}.avatar-48{width:48px;height:48px;font-size:30px}.avatar-64{width:64px;height:64px;font-size:40px}.sources{font-size:.78rem;margin:12px 0 0;color:var(--bt-muted)}.sources a{margin-left:5px}.read-more{text-align:right;margin:5px 0 0;font-size:.86rem;font-weight:700}.archive-cta{text-align:center;margin:30px}.legend{margin:40px 0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:18px 20px;font-size:.8rem}.legend h2{font-size:1rem;color:var(--bt-navy);margin:0}.legend p{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}.footer-banner{display:flex;align-items:center;gap:14px;background:var(--bt-ice-100);border-radius:14px;padding:16px 20px;margin:40px 0}.footer-banner p{flex:1;margin:0;font-size:.85rem}.footer-banner>a{border-radius:999px;background:var(--bt-red);color:#fff;padding:8px 14px;font-size:.78rem;font-weight:700}.empty{background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:28px;color:var(--bt-muted)}.article-header{height:52px;background:var(--bt-ice-200);display:flex;align-items:center;justify-content:space-between;padding:0 max(20px,calc((100% - 1080px)/2));font-size:.8rem}.mini-logo{font-size:1.1rem}.article-page{width:min(720px,calc(100% - 28px));margin:44px auto}.article-page h1{color:var(--bt-navy);font-size:1.35rem;line-height:1.6;margin:18px 0}.article-lead{font-size:1rem;margin:0 0 22px}.article-section{margin:36px 0}.article-section h2{color:var(--bt-navy);border-left:4px solid var(--bt-red);padding-left:12px;font-size:1.08rem}.article-section p{white-space:pre-wrap}.article-page .bingtang-comment{margin:36px 0}.article-actions{border-top:1px solid var(--bt-border);margin-top:38px;padding-top:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.article-actions .sources{margin:0;flex:1}.share{flex:none;border:1px solid var(--bt-navy);border-radius:999px;color:var(--bt-navy);padding:8px 14px;font-size:.8rem}.article-nav{display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:start;border-top:1px solid var(--bt-border);margin-top:32px;padding-top:20px}.article-nav>a:last-child{text-align:right}.article-nav small{display:block;color:var(--bt-muted);line-height:1.5;margin-top:5px}.narrow{width:min(720px,calc(100% - 28px));margin:44px auto}.archive-list{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;overflow:hidden}.archive-list li+li{border-top:1px solid var(--bt-border)}.archive-list a{display:flex;justify-content:space-between;padding:16px 20px;color:var(--bt-navy)}.about section{margin:34px 0}.about h2{color:var(--bt-navy);font-size:1.08rem}.about .profile{display:flex;align-items:center;gap:16px;background:var(--bt-ice-100);border-radius:14px;padding:20px}.about .profile p{margin:0}.site-footer{background:var(--bt-navy);color:#fff;padding:24px max(20px,calc((100% - 1080px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px;font-size:.78rem}.site-footer p{margin:0}.site-footer nav{display:flex;gap:16px}.site-footer a{color:#fff}
@media(max-width:640px){.hero-inner{min-height:230px;padding:18px 14px 0;align-items:flex-start}.brand{padding-bottom:12px}.logo{font-size:1.3rem}.brand p{max-width:190px}.hero-character{height:190px;align-self:flex-end;flex-direction:column-reverse;justify-content:flex-start;gap:4px}.hero-character>p{max-width:150px;padding:7px 9px;font-size:.72rem;line-height:1.45}.bust{width:120px;height:120px}.bust img{height:120px}.bust-fallback{width:92px;height:92px;font-size:42px;margin:0}.main-nav{gap:18px}.main-nav a{font-size:.78rem}.feed,.narrow,.article-page{width:calc(100% - 28px);margin-top:26px}.news-card{padding:20px 14px 16px}.chips time{width:100%;margin-left:0}.source-mix{gap:8px}.bingtang-comment{grid-template-columns:36px minmax(0,1fr);padding:12px 10px}.footer-banner{align-items:flex-start;flex-wrap:wrap}.footer-banner p{min-width:calc(100% - 70px)}.article-header{padding:0 14px}.article-actions{flex-direction:column}.article-nav{grid-template-columns:1fr 1fr}.article-nav>a:nth-child(2){grid-row:2;grid-column:1/-1;text-align:center}.site-footer{align-items:flex-start;flex-direction:column}.article-page h1{font-size:1.2rem}}
`;

main().catch((error) => {
  console.error(`site build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
