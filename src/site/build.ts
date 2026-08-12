import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { getPublishableArticles } from "../renderMarkdown.js";
import { isRelevantEvidenceForTopic, isSafePublicationSourceUrl, normalizeSourceHostname } from "../sourceRelevance.js";
import { resolveSummaryTitle } from "../summaryTitle.js";
import { manualArticleSlug, manualIntakeRoot, readManualIntakeRecord } from "../review/manualPublication.js";
import type { ProcessedArticle, ReviewState, SourceRef, SourceTypeLabel, SummarizedArticle } from "../types.js";

type SiteArticle = { article: ProcessedArticle; slug: string };
type DayData = { date: string; articles: SiteArticle[] };
type SourceMix = { official: number; media: number; sns: number; data: number };

const DATA_DIR = path.resolve(process.env.SITE_DATA_DIR || "data");
const OUTPUT_DIR = path.resolve(process.env.SITE_OUTPUT_DIR || "dist/site");
const OGP_TITLE_FONT_PATH = path.resolve(process.env.SITE_OGP_TITLE_FONT || "docs/assets/fonts/KosugiMaru-Regular.ttf");
const OGP_FALLBACK_FONT_PATH = path.resolve(process.env.SITE_OGP_FALLBACK_FONT || "docs/assets/fonts/NotoSansCJKjp-Regular.otf");
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const BASE_PATH = normalizeBasePath(process.env.SITE_BASE_PATH || "");
const SITE_NAME = "冰糖日报（ビンタンデイリー）";
const SITE_DESCRIPTION = "冰糖日报（ビンタンデイリー）のニュースフィード。";
const ABOUT_PROFILE = "中国エンタメニュース収集担当のAI・冰糖（ビンタン）と、冰糖日报の運営・情報の扱いについて。";
const REVIEW_GATE_ENABLED = process.env.REVIEW_GATE !== "false";
const NON_SERIOUS_AVATARS = ["smile-left", "smile-right", "joy-front", "joy-left", "surprise-front", "surprise-right", "thinking-left", "thinking-up"] as const;
const SERIOUS_AVATARS = ["serious-front", "serious-right"] as const;
const LOSS_PATTERN = /訃報|死去|逝去|死亡|亡くな|急逝|お別れ|追悼|去世|讣告/;

async function main() {
  const days = await loadDays();
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await copySiteAssets();
  await generateDefaultOgp();
  await generateXCardTestImages();

  const nonEmptyDays = days.filter((day) => day.articles.length > 0);
  const newestDate = nonEmptyDays[0]?.date;
  const latest = nonEmptyDays.flatMap((day) => day.articles.map((item) => ({ date: day.date, ...item }))).slice(0, 10);

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

    await Promise.all(day.articles.map(async ({ article, slug }) => {
      const summary = requireSummary(article);
      const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
      const ogImagePath = `/og/${day.date}/${slug}.png`;
      const ogImageVersion = await generateArticleOgp(ogImagePath, title, selectCommentAvatar(article));
      return writePage(`t/${day.date}/${slug}/index.html`, renderLayout({
        title: `${title}｜${SITE_NAME}`,
        description: summary.lead,
        canonicalPath: `/t/${day.date}/${slug}/`,
        ogImagePath: `${ogImagePath}?v=${ogImageVersion}`,
        currentNav: "",
        body: renderArticlePage(day.date, article),
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
  await writeXCardTestPages();
  await writePage("robots.txt", `User-agent: *\nAllow: /\n`);
  await writePage(".htaccess", `AddDefaultCharset UTF-8\n`);
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

  const dayByDate = new Map<string, DayData>();
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
    dayByDate.set(entry.name, { date: entry.name, articles: articles.map((article, index) => ({ article, slug: String(index + 1) })) });
  }
  for (const manual of await loadPublishedManualArticles()) {
    const day = dayByDate.get(manual.date) ?? { date: manual.date, articles: [] };
    day.articles.push({ article: manual.article, slug: manual.slug });
    dayByDate.set(manual.date, day);
  }
  return [...dayByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
}

async function loadPublishedManualArticles(): Promise<Array<{ date: string; article: ProcessedArticle; slug: string }>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(manualIntakeRoot(DATA_DIR), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const published: Array<{ date: string; article: ProcessedArticle; slug: string }> = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d+$/.test(item.name))) {
    const directory = path.join(manualIntakeRoot(DATA_DIR), entry.name);
    let intake: Awaited<ReturnType<typeof readManualIntakeRecord>>;
    let review: ReviewState;
    try {
      [intake, review] = await Promise.all([
        readManualIntakeRecord(directory),
        fs.readFile(path.join(directory, "review.json"), "utf8").then((value) => JSON.parse(value) as ReviewState)
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const publishedDate = typeof intake.published_date === "string" ? intake.published_date : "";
    if (intake.status !== "published" || !/^\d{4}-\d{2}-\d{2}$/.test(publishedDate) || review.status !== "completed") continue;
    const approvedIndex = review.articles.find((item) => item.status === "approved")?.index;
    if (!approvedIndex) continue;
    const articleFiles = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const articleFile = articleFiles.at(-1);
    if (!articleFile) continue;
    const raw = JSON.parse(await fs.readFile(path.join(directory, articleFile), "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${articleFile}: JSONルートは配列である必要があります`);
    const article = normalizeStoredArticle(raw[approvedIndex - 1], `manual ${entry.name}`, approvedIndex - 1);
    validateArticles([article], `manual ${entry.name}`);
    published.push({ date: publishedDate, article, slug: manualArticleSlug(entry.name) });
  }
  return published;
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
    const rawSourceCount = summary.source_list?.length || (article.raw.url ? 1 : 0);
    if (sources.length < rawSourceCount) {
      console.warn(`${date} #${index + 1}: 公開ソースを関連性・URL品質で ${rawSourceCount}件→${sources.length}件に整理`);
    }
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
  const primary = article.raw.sourceName && article.raw.url ? { name: article.raw.sourceName, url: article.raw.url } : undefined;
  const candidates: SourceRef[] = [
    ...(primary ? [primary] : []),
    ...(summary.source_list ?? [])
  ];
  const seenUrls = new Set<string>();
  const seenHosts = new Set<string>();
  const evidenceByUrl = new Map(article.topic?.evidence_articles.map((evidence) => [evidence.url, evidence]) ?? []);
  const sources: Array<{ name: string; url: string }> = [];

  for (const source of candidates) {
    const url = source.url?.trim() ?? "";
    if (!source.name.trim() || !url || !isSafePublicationSourceUrl(url)) continue;
    const isPrimary = url === article.raw.url;
    const evidence = evidenceByUrl.get(url);
    if (!isPrimary && article.topic && (!evidence || !isRelevantEvidenceForTopic(article.topic, evidence))) continue;
    const normalizedUrl = normalizeSourceUrl(url);
    const hostname = normalizeSourceHostname(url);
    if (seenUrls.has(normalizedUrl) || (hostname && seenHosts.has(hostname))) continue;
    seenUrls.add(normalizedUrl);
    if (hostname) seenHosts.add(hostname);
    sources.push({ name: source.name, url });
    if (sources.length >= 4) break;
  }
  return sources;
}

function getRelatedSources(article: ProcessedArticle): Array<{ name: string; url: string }> {
  const summary = requireSummary(article);
  if (!article.topic?.related_evidence_articles?.length) return [];
  const rootUrls = new Set(getSources(article).map((source) => normalizeSourceUrl(source.url)));
  const evidenceByUrl = new Map(article.topic.related_evidence_articles.map((evidence) => [evidence.url, evidence]));
  const sources: Array<{ name: string; url: string }> = [];
  const seenUrls = new Set<string>();
  const seenHosts = new Set<string>();
  for (const source of summary.related_sources ?? []) {
    const url = source.url?.trim() ?? "";
    if (!source.name.trim() || !url || !isSafePublicationSourceUrl(url) || !evidenceByUrl.has(url)) continue;
    const normalizedUrl = normalizeSourceUrl(url);
    const hostname = normalizeSourceHostname(url);
    if (rootUrls.has(normalizedUrl) || seenUrls.has(normalizedUrl) || (hostname && seenHosts.has(hostname))) continue;
    seenUrls.add(normalizedUrl);
    if (hostname) seenHosts.add(hostname);
    sources.push({ name: source.name, url });
    if (sources.length >= 4) break;
  }
  return sources;
}

function getSourceMix(article: ProcessedArticle): SourceMix {
  const summary = requireSummary(article);
  const displayedSources = getSources(article);
  if (article.topic && displayedSources.length) {
    const mix: SourceMix = { official: 0, media: 0, sns: 0, data: 0 };
    const evidenceByUrl = new Map(article.topic.evidence_articles.map((evidence) => [evidence.url, evidence.source_type]));
    for (const source of displayedSources) {
      const type = evidenceByUrl.get(source.url) ?? (source.url === article.raw.url ? article.raw.sourceType : undefined) ?? summary.source_type;
      const partial = sourceTypeToMix(type);
      mix.official += partial.official;
      mix.media += partial.media;
      mix.sns += partial.sns;
      mix.data += partial.data;
    }
    return mix;
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

function renderHome(items: Array<{ date: string; article: ProcessedArticle; slug: string }>) {
  if (!items.length) return `<main class="feed"><section class="empty">この日は記事をお届けできませんでした。収集または生成に失敗したためです。前日までの記事はアーカイブからどうぞ。</section></main>`;
  let lastDate = "";
  const cards = items.map(({ date, article, slug }) => {
    const heading = date !== lastDate ? `<h1 class="date-heading"><a href="${href(`/archive/${date}/`)}">${escapeHtml(formatPickupDate(date))}のピックアップ</a></h1>` : "";
    lastDate = date;
    return `${heading}${renderCard(date, slug, article)}`;
  }).join("");
  return `<main class="feed">${cards}<p class="archive-cta"><a href="${href("/archive/")}">過去の記事はアーカイブへ →</a></p>${renderLegend()}${renderFooterBanner()}</main>`;
}

function renderDaily(day: DayData) {
  const content = day.articles.length
    ? day.articles.map(({ article, slug }) => renderCard(day.date, slug, article)).join("")
    : `<section class="empty">この日は記事をお届けできませんでした。収集または生成に失敗したためです。前日までの記事はアーカイブからどうぞ。</section>`;
  return `<main class="feed"><h1 class="page-title">${escapeHtml(formatLongDate(day.date))}の記事</h1>${content}${renderLegend()}${renderFooterBanner()}</main>`;
}

function renderCard(date: string, slug: string, article: ProcessedArticle) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  const currentUrl = absoluteUrl(`/t/${date}/${slug}/`);
  const referenceArticleDate = summary.published_date || date;
  return `<article class="news-card card-${badgeClass(summary.badge)}">
    <div class="chips">${renderChips(summary)}<time datetime="${escapeAttr(referenceArticleDate)}">参考記事公開日：${escapeHtml(formatNumericDate(referenceArticleDate))}</time></div>
    <h2>${escapeHtml(title)}</h2>
    <p class="lead">${escapeHtml(summary.lead)}</p>
    ${renderSourceMix(article)}
    ${renderFeedDetails(summary)}
    ${renderBingtangComment(article, summary.why_it_matters)}
    ${renderBingtangSupplement(summary.japan_context_note)}
    ${renderSourceRow(article)}
    ${renderRelatedSourceRow(article)}
    ${renderShareLink(currentUrl, title)}
  </article>`;
}

function renderFeedDetails(summary: SummarizedArticle) {
  const sections = [
    renderCardTextSection("何が起きた？", summary.what_happened),
    renderCardTextSection("反応・見られ方", summary.reaction_view)
  ].filter(Boolean).join("");
  return sections ? `<div class="feed-details">${sections}</div>` : "";
}

function renderCardTextSection(title: string, text: string) {
  return text ? `<section><h3>${renderSectionIcon(sectionIconFor(title))}${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>` : "";
}

function renderArticlePage(date: string, article: ProcessedArticle) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  return `<main class="article-page">
    <article>
      <div class="chips">${renderChips(summary)}<time datetime="${escapeAttr(date)}">${escapeHtml(formatNumericDate(summary.event_date || summary.published_date || date))}</time></div>
      <h1>${escapeHtml(title)}</h1>
      <p class="article-lead">${escapeHtml(summary.lead)}</p>
      ${renderSourceMix(article)}
      ${renderTextSection("何が起きた？", summary.what_happened)}
      ${renderBingtangComment(article, summary.why_it_matters, summary.editor_comment)}
      ${renderTextSection("反応・見られ方", summary.reaction_view)}
      ${renderBingtangSupplement(summary.japan_context_note)}
      <div class="article-actions">${renderSourceRow(article)}${renderRelatedSourceRow(article)}</div>
    </article>
  </main>`;
}

function renderChips(summary: SummarizedArticle) {
  return `<span class="chip badge badge-${badgeClass(summary.badge)}">${escapeHtml(summary.badge)}</span>
    <span class="chip category">${escapeHtml(summary.category)}</span>`;
}

function renderSourceMix(article: ProcessedArticle) {
  const mix = getSourceMix(article);
  return `<div class="source-mix"><strong>${renderSectionIcon("source")}ソース構成</strong>
    ${pip("official", "公式", mix.official)}${pip("media", "媒体", mix.media)}${pip("sns", "SNS", mix.sns)}${pip("data", "データ", mix.data)}
  </div>`;
}

function pip(kind: string, label: string, count: number) {
  return `<span class="pip${count === 0 ? " zero" : ""}"><i class="pip-${kind}"></i>${label} ${count}</span>`;
}

function renderBingtangComment(article: ProcessedArticle, main: string, closing = "") {
  if (!main && !closing) return "";
  return `<section class="bingtang-comment">
    ${renderAvatar("avatar-comment", selectCommentAvatar(article))}
    <div><h3>${renderSectionIcon("point")}ビンタンの注目ポイント</h3>${main ? `<p>${escapeHtml(main)}</p>` : ""}${closing ? `<hr><p>${escapeHtml(closing)}</p>` : ""}</div>
  </section>`;
}

function renderBingtangSupplement(text: string) {
  if (!text) return "";
  return `<section class="bingtang-supplement">
    <div><h3>${renderSectionIcon("supplement")}ビンタンからの補足</h3><p>${escapeHtml(text)}</p></div>
  </section>`;
}

type SectionIconName = "source" | "event" | "reaction" | "point" | "supplement";

function sectionIconFor(title: string): SectionIconName {
  return title === "反応・見られ方" ? "reaction" : "event";
}

function renderSectionIcon(name: SectionIconName) {
  const shapes: Record<SectionIconName, string> = {
    source: `<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>`,
    event: `<path d="m10 2 2 2 2-2M10 22l2-2 2 2M2 10l2 2-2 2M22 10l-2 2 2 2M4.93 4.93l2.83.83.83 2.83M15.41 15.41l.83 2.83 2.83.83M19.07 4.93l-.83 2.83-2.83.83M8.59 15.41l-.83 2.83-2.83.83M2 12h20M12 2v20"/>`,
    reaction: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`,
    point: `<path d="m12 3-1.9 4.8L5 10l5.1 2.2L12 17l1.9-4.8L19 10l-5.1-2.2L12 3Z"/><path d="m5 3-.6 1.4L3 5l1.4.6L5 7l.6-1.4L7 5l-1.4-.6L5 3ZM19 17l-.8 2.2L16 20l2.2.8L19 23l.8-2.2L22 20l-2.2-.8L19 17Z"/>`,
    supplement: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`
  };
  return `<svg class="section-icon section-icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
}

function selectCommentAvatar(article: ProcessedArticle) {
  const summary = requireSummary(article);
  const title = resolveSummaryTitle(summary.title_ja, article.raw.title);
  const context = [summary.category, title, summary.lead, ...(summary.tags ?? [])].join(" ");
  const choices = LOSS_PATTERN.test(context) ? SERIOUS_AVATARS : NON_SERIOUS_AVATARS;
  const seed = summary.topic_key || `${title}|${summary.why_it_matters}`;
  return `bingtang-avatar-${choices[stableHash(seed) % choices.length]}.png`;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function renderShareLink(currentUrl: string, title: string) {
  return `<p class="feed-actions"><a class="share" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(currentUrl)}&text=${encodeURIComponent(title)}" target="_blank" rel="noopener noreferrer">Xでシェア</a></p>`;
}

function renderTextSection(title: string, text: string) {
  return text ? `<section class="article-section"><h2>${renderSectionIcon(sectionIconFor(title))}${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>` : "";
}

function renderSourceRow(article: ProcessedArticle) {
  return `<p class="sources"><strong>ソース:</strong> ${getSources(article).map((source) => `<a href="${escapeAttr(source.url)}" rel="noopener noreferrer">${escapeHtml(source.name)}</a>`).join("、")}</p>`;
}

function renderRelatedSourceRow(article: ProcessedArticle) {
  const sources = getRelatedSources(article);
  return sources.length
    ? `<p class="sources related-sources"><strong>関連角度のソース:</strong> ${sources.map((source) => `<a href="${escapeAttr(source.url)}" rel="noopener noreferrer">${escapeHtml(source.name)}</a>`).join("、")}</p>`
    : "";
}

function renderArchive(days: DayData[]) {
  const list = days.length
    ? days.map((day) => `<li><a href="${href(`/archive/${day.date}/`)}"><time datetime="${day.date}">${escapeHtml(formatLongDate(day.date))}</time><span>${day.articles.length}本</span></a></li>`).join("")
    : "<li>アーカイブはまだありません。</li>";
  return `<main class="narrow"><h1 class="page-title">アーカイブ</h1><ul class="archive-list">${list}</ul></main>`;
}

function renderAbout() {
  return `<main class="narrow about"><h1 class="page-title">このサイトについて</h1>
    <section class="about-hero"><div class="about-character"><img src="${href("/assets/bingtang-about-fullbody.png")}" alt="紹介文へ手を差し出す冰糖（ビンタン）の全身イラスト"></div><div class="about-intro"><h2>はじめまして、中国エンタメニュース収集担当のAI、冰糖（ビンタン）です。</h2><p>私は、中国語圏の映画、ドラマ、俳優、興行、配信、ファン文化に関するニュースを、公式発表や現地媒体などから毎日集めています。</p><p>公式発表を日本語に訳すだけではなく、現地媒体の報じ方、確認できる範囲でのSNSの反応、興行や配信の数字などを見比べながら、「何が起きたのか」「なぜ話題なのか」「どこまで確認できるのか」を日本語で整理します。</p><p>私が集めた情報の中から、記事ごとに気になるポイントや、日本語で読むときに知っておきたい背景をお伝えします。日本ではまだあまり知られていない作品や、小さくても熱量の高い話題も拾っていきます。</p></div></section>
    <section class="about-section"><h2>運営について</h2><p>冰糖日报は、AIが情報収集、整理、記事原稿の作成を行う個人運営のニュースフィードです。</p><p>運営者はニュース選定方針の設計とサイト運用を行い、必要に応じて記事の確認や修正をしています。ただし、掲載するすべてのニュースについて、人間が裏取りや個別の事実確認を行っているわけではありません。重要な判断に利用する場合は、記事内のリンクから元の情報源をご確認ください。</p></section>
    <section class="about-section"><h2>情報の扱い</h2><ul><li>公式発表、現地媒体、SNS、データは性質の異なる情報として扱います。</li><li>噂やSNS上の反応は事実と区別し、未確認情報を断定しません。</li><li>記事は作成時点で取得できた公開情報をもとに生成しており、AIによる読み違い、情報の欠落、不正確な記述が含まれる可能性があります。</li><li>情報の正確性、完全性、最新性を保証するものではありません。</li></ul></section>
    <section class="about-contact"><h2>連絡先</h2><p>記事の訂正、権利関係、そのほかのご連絡は、Xの <a href="https://x.com/fal48" target="_blank" rel="noopener noreferrer">@fal48</a> までお願いします。</p></section>
  </main>`;
}

function renderLegend() {
  return `<aside class="legend"><h2>表示の見方</h2><p><span class="chip badge badge-news">NEWS</span> 報道　<span class="chip badge badge-official">OFFICIAL</span> 公式　<span class="chip badge badge-data">DATA</span> データ</p><p>${pip("official", "公式", 1)}${pip("media", "媒体", 1)}${pip("sns", "SNS", 1)}${pip("data", "データ", 1)} は記事で使ったソースの構成です。</p></aside>`;
}

function renderFooterBanner() {
  return `<aside class="footer-banner">${renderAvatar("avatar-48", "bingtang-avatar-smile-left.png")}<p>過去の記事はアーカイブにありますよ！</p><a href="${href("/about/")}">このサイトについて →</a></aside>`;
}

function renderAvatar(sizeClass: string, imageName = "bingtang-avatar-smile-left.png") {
  return `<span class="avatar ${sizeClass}"><img src="${href(`/assets/${imageName}`)}" alt="ビンタン（AI秘書）" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="avatar-fallback" hidden aria-hidden="true">🧊</span></span>`;
}

function renderLayout(options: { title: string; description: string; canonicalPath: string; currentNav: "latest" | "archive" | "about" | ""; body: string; fullHeader: boolean; headerDate?: string; articleDate?: string; ogImagePath?: string }) {
  const canonicalUrl = absoluteUrl(options.canonicalPath);
  const ogImageUrl = absoluteUrl(options.ogImagePath || "/assets/ogp-default.png");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title><meta name="description" content="${escapeAttr(options.description)}"><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="${options.fullHeader ? "website" : "article"}"><meta property="og:site_name" content="${SITE_NAME}"><meta property="og:title" content="${escapeAttr(options.title)}"><meta property="og:description" content="${escapeAttr(options.description)}"><meta property="og:url" content="${canonicalUrl}"><meta property="og:image" content="${ogImageUrl}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${SITE_NAME}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeAttr(options.title)}"><meta name="twitter:description" content="${escapeAttr(options.description)}"><meta name="twitter:image" content="${ogImageUrl}"><meta name="twitter:image:alt" content="${SITE_NAME}"><link rel="icon" href="${href("/assets/favicon-32.png")}"><style>${V2_CSS}</style></head><body>
  ${options.fullHeader ? renderHeader(options.currentNav, options.headerDate) : renderArticleHeader(options.articleDate || "")}
  ${options.body}${renderFooter()}</body></html>`;
}

function renderHeader(current: "latest" | "archive" | "about" | "", date?: string) {
  return `<header class="hero"><div class="hero-inner"><div class="brand"><a href="${href("/")}" class="logo"><img src="${href("/assets/bingtang-logo-horizontal.png")}" alt="冰糖日报 ビンタンデイリー"></a>${date ? `<time class="date-badge" datetime="${date}">最終更新：${escapeHtml(formatUpdatedDate(date))}</time>` : ""}</div><div class="hero-character"><img src="${href("/assets/bingtang-hero-v2.png")}" alt="片手を上げて挨拶するビンタン"></div></div>${renderNav(current)}</header>`;
}

function renderNav(current: "latest" | "archive" | "about" | "") {
  return `<nav class="main-nav"><a${current === "latest" ? " class=\"current\"" : ""} href="${href("/")}">最新</a><a${current === "archive" ? " class=\"current\"" : ""} href="${href("/archive/")}">アーカイブ</a><a${current === "about" ? " class=\"current\"" : ""} href="${href("/about/")}">このサイトについて</a></nav>`;
}

function renderArticleHeader(date: string) {
  return `<header class="article-header"><a href="${href("/")}" class="mini-logo"><img src="${href("/assets/bingtang-logo-compact.png")}" alt="冰糖日报"></a><a href="${href(`/archive/${date}/`)}">← ${escapeHtml(date)} の一覧へ</a></header>`;
}

function renderFooter() {
  return `<footer class="site-footer"><p>冰糖日报（ビンタンデイリー）／記事はAIが収集・生成しています。運営については<a href="${href("/about/")}">「このサイトについて」</a>をご覧ください。／© 2026 冰糖日报</p><nav><a href="${href("/about/")}">このサイトについて</a><a href="${href("/archive/")}">アーカイブ</a></nav></footer>`;
}

function badgeClass(badge: string) {
  if (badge === "OFFICIAL" || badge === "PR WATCH") return "official";
  if (badge === "DATA") return "data";
  return "news";
}

function formatLongDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(parsed).replace(/\((.)\)$/, "（$1）");
}

function formatUpdatedDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(parsed);
}

function formatShortDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(parsed).replace(/\((.)\)$/, "（$1）");
}

function formatPickupDate(date: string) {
  const parsed = parseDate(date);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(parsed);
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

function normalizeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|scm$|spm$|from$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

async function generateDefaultOgp() {
  const destination = path.join(OUTPUT_DIR, "assets", "ogp-default.png");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const logo = await readAsset("bingtang-logo-horizontal.png");
  const hero = await readAsset("bingtang-hero-v2.png");
  const composites: sharp.OverlayOptions[] = [];
  if (logo) composites.push({ input: await sharp(logo).resize({ width: 570, height: 145, fit: "inside" }).png().toBuffer(), left: 76, top: 82 });
  if (hero) composites.push({ input: await sharp(hero).resize({ width: 390, height: 490, fit: "inside" }).png().toBuffer(), left: 760, top: 120 });
  await sharp(Buffer.from(ogpBackgroundSvg("default")))
    .composite(composites)
    .png()
    .toFile(destination);
}

type XCardTest = {
  slug: "a" | "b" | "c";
  card: "summary" | "summary_large_image";
  imagePath: string;
  imageType: "image/jpeg" | "image/png";
  label: string;
};

const X_CARD_TESTS: XCardTest[] = [
  { slug: "a", card: "summary", imagePath: "/x-card-test/fixture.jpg", imageType: "image/jpeg", label: "A: summary + JPEG" },
  { slug: "b", card: "summary_large_image", imagePath: "/x-card-test/fixture.jpg", imageType: "image/jpeg", label: "B: summary_large_image + JPEG" },
  { slug: "c", card: "summary_large_image", imagePath: "/x-card-test/fixture.png", imageType: "image/png", label: "C: summary_large_image + PNG" }
];

async function generateXCardTestImages() {
  const source = path.join(OUTPUT_DIR, "assets", "ogp-default.png");
  const directory = path.join(OUTPUT_DIR, "x-card-test");
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    sharp(source).jpeg({ quality: 88, chromaSubsampling: "4:2:0" }).toFile(path.join(directory, "fixture.jpg")),
    fs.copyFile(source, path.join(directory, "fixture.png"))
  ]);
}

async function writeXCardTestPages() {
  await Promise.all(X_CARD_TESTS.map(async (test) => {
    const canonicalPath = `/x-card-test/${test.slug}/`;
    const canonicalUrl = absoluteUrl(canonicalPath);
    const imageUrl = absoluteUrl(test.imagePath);
    const title = `Xカード比較 ${test.label}｜${SITE_NAME}`;
    const description = "Xカードの取得条件を切り分けるための比較用ページです。";
    await writePage(`x-card-test/${test.slug}/index.html`, `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${description}"><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="website"><meta property="og:site_name" content="${SITE_NAME}"><meta property="og:title" content="${escapeAttr(title)}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonicalUrl}"><meta property="og:image" content="${imageUrl}"><meta property="og:image:type" content="${test.imageType}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${SITE_NAME} Xカード比較 ${test.label}"><meta name="twitter:card" content="${test.card}"><meta name="twitter:title" content="${escapeAttr(title)}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${imageUrl}"><meta name="twitter:image:alt" content="${SITE_NAME} Xカード比較 ${test.label}"></head><body><main><h1>${escapeHtml(title)}</h1><p>このページはXカードの比較検証専用です。</p><dl><dt>twitter:card</dt><dd>${test.card}</dd><dt>OGP画像</dt><dd>${imageUrl}</dd><dt>画像形式</dt><dd>${test.imageType}</dd></dl></main></body></html>`);
  }));
}

async function generateArticleOgp(sitePath: string, title: string, avatarName: string) {
  const destination = path.join(OUTPUT_DIR, sitePath.replace(/^\/+/, ""));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const logo = await readAsset("bingtang-logo-horizontal.png");
  const avatar = await readAsset(avatarName);
  const { fontSize, lines } = fitOgpTitle(title);
  await Promise.all([fs.access(OGP_TITLE_FONT_PATH), fs.access(OGP_FALLBACK_FONT_PATH)]);
  const titleMarkup = lines.map((line, index) => `<text x="82" y="${244 + index * (fontSize * 1.43)}" class="title">${xmlEscape(line)}</text>`).join("");
  const svg = ogpBackgroundSvg("article", `<style>.title{font-family:'Kosugi Maru','Noto Sans CJK JP';font-size:${fontSize}px;font-weight:400;fill:#18375F;letter-spacing:.01em}</style>${titleMarkup}`);
  const background = new Resvg(svg, {
    font: {
      fontFiles: [OGP_TITLE_FONT_PATH, OGP_FALLBACK_FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: "Kosugi Maru"
    }
  }).render().asPng();
  const composites: sharp.OverlayOptions[] = [];
  if (logo) composites.push({ input: await sharp(logo).resize({ width: 430, height: 110, fit: "inside" }).png().toBuffer(), left: 70, top: 54 });
  if (avatar) composites.push({ input: await sharp(avatar).resize({ width: 164, height: 164, fit: "contain" }).png().toBuffer(), left: 982, top: 424 });
  await sharp(background).composite(composites).png().toFile(destination);
  const image = await fs.readFile(destination);
  return createHash("sha256").update(image).digest("hex").slice(0, 12);
}

function ogpBackgroundSvg(kind: "default" | "article", content = "") {
  const avatarCircle = kind === "article" ? `<circle cx="1064" cy="506" r="92" fill="#FFFFFF" stroke="#A9D9F2" stroke-width="5"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs><linearGradient id="ice" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#F8FCFF"/><stop offset="1" stop-color="#EAF7FD"/></linearGradient></defs>
    <rect width="1200" height="630" fill="url(#ice)"/>
    <path d="M0 0h310L88 214H0z" fill="#DDF2FB" opacity=".8"/><path d="M1200 0v206L994 0z" fill="#F8DADA" opacity=".55"/>
    <path d="M0 630V472l176 158z" fill="#EEF8FC"/><path d="M1200 630H884l316-250z" fill="#DDF2FB" opacity=".9"/>
    <g fill="#6BB9E8" opacity=".34"><circle cx="112" cy="344" r="6"/><circle cx="144" cy="372" r="3"/><path d="M1090 122l5 16 16 5-16 5-5 16-5-16-16-5 16-5z"/></g>
    <g fill="#D62F2A" opacity=".24"><circle cx="1160" cy="278" r="7"/><circle cx="1127" cy="302" r="4"/></g>
    ${avatarCircle}${content}
  </svg>`;
}

function fitOgpTitle(title: string) {
  const clean = title.replace(/\s+/g, " ").trim();
  for (const fontSize of [72, 66, 60, 54]) {
    const maxUnits = 880 / fontSize;
    const lines = wrapByVisualUnits(clean, maxUnits, 3);
    if (lines.join("").replace(/…$/, "").length >= Array.from(clean).length || fontSize === 54) return { fontSize, lines };
  }
  return { fontSize: 54, lines: [clean] };
}

function wrapByVisualUnits(value: string, maxUnits: number, maxLines: number) {
  const characters = Array.from(value);
  const lines: string[] = [];
  let current = "";
  let units = 0;
  let consumed = 0;
  for (const character of characters) {
    const width = /[\u0000-\u00ff]/.test(character) ? 0.56 : 1;
    if (current && units + width > maxUnits) {
      lines.push(current.trim());
      if (lines.length === maxLines) break;
      current = "";
      units = 0;
    }
    current += character;
    units += width;
    consumed += 1;
  }
  if (lines.length < maxLines && current.trim()) lines.push(current.trim());
  if (consumed < characters.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[、。・\s]+$/, "")}…`;
  return lines;
}

function xmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

async function readAsset(name: string) {
  try {
    return await fs.readFile(path.join(OUTPUT_DIR, "assets", name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

const LEGACY_CSS = String.raw`
:root{--bt-ice:#A7CDDF;--bt-red:#C12B23;--bt-amber:#CD7019;--bt-navy:#1F3043;--bt-ivory:#F0E6DA;--bt-ice-50:#F6FAFC;--bt-ice-100:#EAF4FA;--bt-ice-200:#DEEEF6;--bt-ice-600:#4E8FAE;--bt-red-dark:#A32017;--bt-amber-50:#FBF1E2;--bt-amber-900:#7A4A10;--bt-text:#2A3948;--bt-muted:#6E7E8C;--bt-border:#DCE8EF;--bt-card:#FFF;--bt-silver:#9AA7B1;--bt-gray:#C2CBD2}
*{box-sizing:border-box}html{overflow-x:hidden;background:var(--bt-ice-50);color:var(--bt-text);font-family:"Hiragino Maru Gothic ProN","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;font-size:16px}body{margin:0;overflow-x:hidden;line-height:1.85}a{color:var(--bt-red);text-decoration:none}a:hover{text-decoration:underline;color:var(--bt-red-dark)}.hero{background:var(--bt-ice-200);border-bottom:1px solid var(--bt-border)}.hero-inner{max-width:1080px;min-height:220px;margin:auto;padding:24px 32px 0;display:flex;align-items:center;justify-content:space-between}.brand{padding-bottom:24px}.logo,.mini-logo{font-weight:900;letter-spacing:.04em}.logo{display:block;font-size:1.6rem;line-height:1.25}.logo span,.mini-logo span{color:var(--bt-navy)}.logo b,.mini-logo b{color:var(--bt-red)}.subtitle{display:block;color:var(--bt-red);font-size:.8rem;font-weight:700}.brand p{color:var(--bt-muted);font-size:.85rem}.brand p span{color:var(--bt-red)}.date-badge{display:inline-block;background:#fff;border:1px solid var(--bt-border);border-radius:999px;padding:4px 12px;font-size:.78rem}.hero-character{height:200px;display:flex;align-items:center;gap:12px}.hero-character>p{position:relative;max-width:220px;margin:0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:12px 16px;font-size:.85rem;font-weight:700;color:var(--bt-navy)}.bust{width:190px;height:200px;display:grid;place-items:end center;overflow:hidden}.bust img{max-width:100%;height:200px;object-fit:contain;object-position:bottom}.bust-fallback{width:150px;height:150px;border-radius:50%;background:var(--bt-ice);display:grid;place-items:center;font-size:64px;margin-bottom:16px}.main-nav{height:52px;background:#fff;display:flex;align-items:center;justify-content:center;gap:42px}.main-nav a{height:52px;padding:12px 4px;color:var(--bt-navy);font-weight:700}.main-nav a.current{border-bottom:2px solid var(--bt-red);color:var(--bt-red)}.feed{width:min(820px,calc(100% - 28px));margin:36px auto}.date-heading{text-align:center;font-size:1.2rem;margin:40px 0 20px}.date-heading a{color:var(--bt-navy)}.page-title{color:var(--bt-navy);font-size:1.45rem;margin:0 0 28px}.news-card{position:relative;background:var(--bt-card);border:1px solid var(--bt-border);border-radius:14px;box-shadow:0 1px 3px rgba(31,48,67,.08);padding:22px 20px 18px;margin-bottom:20px;overflow:hidden}.news-card:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--bt-red)}.news-card.card-official:before{background:var(--bt-navy)}.news-card.card-data:before{background:var(--bt-ice-600)}.chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.chips time{margin-left:auto;color:var(--bt-muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.chip{display:inline-flex;align-items:center;min-height:27px;border-radius:999px;padding:2px 10px;font-size:.75rem;font-weight:700;line-height:1.4}.badge{color:#fff}.badge-news{background:var(--bt-red)}.badge-official{background:var(--bt-navy)}.badge-data{background:var(--bt-ice-600)}.category{background:var(--bt-ivory);color:var(--bt-navy)}.confidence{background:#fff;border:1.5px solid var(--bt-gray);color:var(--bt-muted)}.confidence-A{border-color:var(--bt-amber);color:var(--bt-amber-900)}.confidence-B{border-color:var(--bt-silver);color:#5F6E79}.freshness{border-radius:5px;background:#fff;border:1px solid var(--bt-red);color:var(--bt-red)}.freshness-today{background:var(--bt-red);color:#fff}.news-card h2{font-size:1.08rem;line-height:1.6;margin:14px 0 8px}.news-card h2 a{color:var(--bt-navy)}.lead{font-size:.92rem;margin:0 0 14px}.clamp-3{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.source-mix{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#FAF8F5;border-radius:10px;padding:8px 12px;color:var(--bt-muted);font-size:.78rem}.source-mix strong{margin-right:2px}.pip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.pip.zero{opacity:.4}.pip i{width:9px;height:9px;border-radius:50%;background:var(--bt-navy)}.pip i.pip-media{background:var(--bt-red)}.pip i.pip-sns{background:var(--bt-amber)}.pip i.pip-data{background:var(--bt-ice-600)}.official-warning{display:inline-flex;border:1px solid #E8CFA4;border-radius:6px;background:var(--bt-amber-50);color:var(--bt-amber-900);font-size:.76rem;font-weight:700;padding:4px 8px}.bingtang-comment{display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px;margin:16px 0 12px;background:var(--bt-ice-100);border:1px solid var(--bt-ice);border-radius:4px 14px 14px;padding:14px}.bingtang-comment h3{color:var(--bt-red);font-size:.9rem;line-height:1.4;margin:0 0 6px}.bingtang-comment p{margin:0;font-size:.88rem;line-height:1.8}.bingtang-comment hr{border:0;border-top:1px solid var(--bt-ice);margin:14px 0}.bingtang-comment.clamp-4>div{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}.avatar{flex:none;display:inline-grid;border-radius:50%;overflow:hidden;background:var(--bt-ice);border:2px solid var(--bt-ice);place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}.avatar-fallback{display:grid;place-items:center;width:100%;height:100%;font-size:.55em}.avatar-36{width:36px;height:36px;font-size:24px}.avatar-48{width:48px;height:48px;font-size:30px}.avatar-64{width:64px;height:64px;font-size:40px}.sources{font-size:.78rem;margin:12px 0 0;color:var(--bt-muted)}.sources a{margin-left:5px}.read-more{text-align:right;margin:5px 0 0;font-size:.86rem;font-weight:700}.archive-cta{text-align:center;margin:30px}.legend{margin:40px 0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:18px 20px;font-size:.8rem}.legend h2{font-size:1rem;color:var(--bt-navy);margin:0}.legend p{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}.footer-banner{display:flex;align-items:center;gap:14px;background:var(--bt-ice-100);border-radius:14px;padding:16px 20px;margin:40px 0}.footer-banner p{flex:1;margin:0;font-size:.85rem}.footer-banner>a{border-radius:999px;background:var(--bt-red);color:#fff;padding:8px 14px;font-size:.78rem;font-weight:700}.empty{background:#fff;border:1px solid var(--bt-border);border-radius:14px;padding:28px;color:var(--bt-muted)}.article-header{height:52px;background:var(--bt-ice-200);display:flex;align-items:center;justify-content:space-between;padding:0 max(20px,calc((100% - 1080px)/2));font-size:.8rem}.mini-logo{font-size:1.1rem}.article-page{width:min(720px,calc(100% - 28px));margin:44px auto}.article-page h1{color:var(--bt-navy);font-size:1.35rem;line-height:1.6;margin:18px 0}.article-lead{font-size:1rem;margin:0 0 22px}.article-section{margin:36px 0}.article-section h2{color:var(--bt-navy);border-left:4px solid var(--bt-red);padding-left:12px;font-size:1.08rem}.article-section p{white-space:pre-wrap}.article-page .bingtang-comment{margin:36px 0}.article-actions{border-top:1px solid var(--bt-border);margin-top:38px;padding-top:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.article-actions .sources{margin:0;flex:1}.share{flex:none;border:1px solid var(--bt-navy);border-radius:999px;color:var(--bt-navy);padding:8px 14px;font-size:.8rem}.article-nav{display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:start;border-top:1px solid var(--bt-border);margin-top:32px;padding-top:20px}.article-nav>a:last-child{text-align:right}.article-nav small{display:block;color:var(--bt-muted);line-height:1.5;margin-top:5px}.narrow{width:min(720px,calc(100% - 28px));margin:44px auto}.archive-list{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--bt-border);border-radius:14px;overflow:hidden}.archive-list li+li{border-top:1px solid var(--bt-border)}.archive-list a{display:flex;justify-content:space-between;padding:16px 20px;color:var(--bt-navy)}.about section{margin:34px 0}.about h2{color:var(--bt-navy);font-size:1.08rem}.about .profile{display:flex;align-items:center;gap:16px;background:var(--bt-ice-100);border-radius:14px;padding:20px}.about .profile p{margin:0}.site-footer{background:var(--bt-navy);color:#fff;padding:24px max(20px,calc((100% - 1080px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px;font-size:.78rem}.site-footer p{margin:0}.site-footer nav{display:flex;gap:16px}.site-footer a{color:#fff}
@media(max-width:640px){.hero-inner{min-height:230px;padding:18px 14px 0;align-items:flex-start}.brand{padding-bottom:12px}.logo{font-size:1.3rem}.brand p{max-width:190px}.hero-character{height:190px;align-self:flex-end;flex-direction:column-reverse;justify-content:flex-start;gap:4px}.hero-character>p{max-width:150px;padding:7px 9px;font-size:.72rem;line-height:1.45}.bust{width:120px;height:120px}.bust img{height:120px}.bust-fallback{width:92px;height:92px;font-size:42px;margin:0}.main-nav{gap:18px}.main-nav a{font-size:.78rem}.feed,.narrow,.article-page{width:calc(100% - 28px);margin-top:26px}.news-card{padding:20px 14px 16px}.chips time{width:100%;margin-left:0}.source-mix{gap:8px}.bingtang-comment{grid-template-columns:36px minmax(0,1fr);padding:12px 10px}.footer-banner{align-items:flex-start;flex-wrap:wrap}.footer-banner p{min-width:calc(100% - 70px)}.article-header{padding:0 14px}.article-actions{flex-direction:column}.article-nav{grid-template-columns:1fr 1fr}.article-nav>a:nth-child(2){grid-row:2;grid-column:1/-1;text-align:center}.site-footer{align-items:flex-start;flex-direction:column}.article-page h1{font-size:1.2rem}}
.date-badge{margin-top:18px}.feed-details{margin:14px 0 10px;border:1px solid var(--bt-border);border-radius:10px;background:#fff;padding:4px 14px 14px}.feed-details section{margin:16px 0}.feed-details h3{margin:0 0 5px;color:var(--bt-navy);font-size:.92rem}.feed-details p{margin:0;white-space:pre-wrap;font-size:.88rem}.bingtang-comment>div{display:block;overflow:visible}.bingtang-supplement{background:#fff;border-color:var(--bt-border);margin-top:12px}.bingtang-supplement h3{color:var(--bt-navy)}.feed-actions{text-align:right;margin:12px 0 0}.feed-actions .share{display:inline-block}
@media(max-width:640px){.hero-inner{min-height:190px;gap:0}.brand{flex:1;min-width:0;padding:10px 0 18px}.date-badge{margin-top:14px;padding:3px 9px;font-size:.7rem}.hero-character{position:relative;display:block;flex:none;width:140px;height:172px;align-self:flex-end}.hero-character>p{position:absolute;z-index:2;top:4px;right:0;width:140px;max-width:none;padding:7px 9px}.bust{position:absolute;right:0;bottom:0;width:120px;height:120px}.bust img{height:120px}.feed-details{padding-inline:12px}}
`;

const V2_CSS = String.raw`
@import url('https://fonts.googleapis.com/css2?family=Kosugi+Maru&family=Zen+Kaku+Gothic+New:wght@400;500&display=swap');
:root{--ice:#4A9FE3;--ice-soft:#EAF7FD;--ice-pale:#F6FCFF;--red:#D62F2A;--red-dark:#B92320;--navy:#18375F;--text:#263B50;--muted:#75889A;--line:#D8EAF4;--white:#FFF;--amber:#D78B31}
*{box-sizing:border-box}html{overflow-x:hidden;background:var(--ice-pale);color:var(--text);font-family:"Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;font-size:16px}body{margin:0;overflow-x:hidden;line-height:1.85}a{color:var(--red);text-decoration:none}a:hover{color:var(--red-dark);text-decoration:underline}.hero{position:relative;background:linear-gradient(135deg,#F6FCFF 0%,#DFF3FC 58%,#EAF8FE 100%);border-bottom:1px solid var(--line);overflow:hidden}.hero:before{content:"✦　❄　·　✧　　　❄　·　✦";position:absolute;inset:12px 0 auto;color:#72B9E4;opacity:.26;font-size:38px;letter-spacing:22px;white-space:nowrap;pointer-events:none}.hero:after{content:"";position:absolute;right:-70px;top:-80px;width:330px;height:330px;border:1px solid rgba(74,159,227,.18);transform:rotate(36deg);pointer-events:none}.hero-inner{position:relative;z-index:1;width:min(1080px,calc(100% - 40px));min-height:246px;margin:auto;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;flex-direction:column;align-items:flex-start;padding:22px 0}.logo{display:block}.logo img{display:block;width:min(430px,44vw);height:auto}.date-badge{display:inline-block;margin-top:18px;color:var(--muted);font-size:.78rem;letter-spacing:.02em}.hero-character{align-self:flex-end;width:300px;height:242px;display:flex;align-items:flex-end;justify-content:center}.hero-character img{display:block;max-width:100%;height:242px;object-fit:contain;object-position:bottom}.main-nav{position:relative;z-index:1;height:54px;background:rgba(255,255,255,.94);display:flex;align-items:center;justify-content:center;gap:46px;border-top:1px solid rgba(255,255,255,.85)}.main-nav a{height:54px;padding:13px 4px 11px;color:var(--navy);font-weight:700;font-size:.86rem}.main-nav a.current{color:var(--red);border-bottom:3px solid var(--red)}.feed{width:min(820px,calc(100% - 28px));margin:38px auto}.date-heading{text-align:center;font:400 1.18rem/1.5 "Kosugi Maru","Hiragino Maru Gothic ProN",sans-serif;margin:42px 0 20px}.date-heading a,.page-title{color:var(--navy)}.page-title{font:400 1.5rem/1.5 "Kosugi Maru","Hiragino Maru Gothic ProN",sans-serif;margin:0 0 28px}.news-card{position:relative;background:var(--white);border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 32px rgba(36,86,119,.08);padding:24px 24px 20px;margin-bottom:24px;overflow:hidden}.news-card:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--red)}.news-card.card-official:before{background:var(--navy)}.news-card.card-data:before{background:var(--ice)}.chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.chips time{margin-left:auto;color:var(--muted);font-size:.75rem;letter-spacing:.03em}.chip{display:inline-flex;align-items:center;min-height:27px;border-radius:7px;padding:3px 10px;font-size:.72rem;font-weight:800;line-height:1.4}.badge{color:#fff}.badge-news{background:var(--red)}.badge-official{background:var(--navy)}.badge-data{background:var(--ice);color:var(--navy)}.category{background:var(--ice-soft);color:var(--navy)}.news-card h2{color:var(--navy);font:400 1.18rem/1.65 "Kosugi Maru","Hiragino Maru Gothic ProN",sans-serif;margin:16px 0 8px}.lead{font-size:.93rem;margin:0 0 15px}.source-mix{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#F7FBFD;border-radius:10px;padding:8px 12px;color:var(--muted);font-size:.78rem}.source-mix strong{color:var(--navy);margin-right:2px}.pip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.pip.zero{opacity:.38}.pip i{width:9px;height:9px;border-radius:50%;background:var(--navy)}.pip i.pip-media{background:var(--red)}.pip i.pip-sns{background:var(--amber)}.pip i.pip-data{background:var(--ice)}.feed-details{margin:14px 0 10px;border:1px solid var(--line);border-radius:12px;background:#fff;padding:3px 15px 14px}.feed-details section{margin:16px 0}.feed-details h3{margin:0 0 5px;color:var(--navy);font-size:.91rem}.feed-details p{margin:0;white-space:pre-wrap;font-size:.88rem}.bingtang-comment{display:grid;grid-template-columns:42px minmax(0,1fr);gap:13px;margin:16px 0 12px;background:var(--ice-soft);border:1px solid #CBE8F7;border-radius:5px 15px 15px;padding:15px}.bingtang-comment h3,.bingtang-supplement h3{font-size:.9rem;line-height:1.4;margin:0 0 6px}.bingtang-comment h3{color:var(--red)}.bingtang-comment p,.bingtang-supplement p{margin:0;font-size:.88rem;line-height:1.8}.bingtang-comment hr{border:0;border-top:1px solid #CBE8F7;margin:14px 0}.bingtang-supplement{margin:12px 0;background:#F8FBFD;border:1px solid var(--line);border-left:3px solid var(--ice);border-radius:5px 12px 12px 5px;padding:13px 15px}.bingtang-supplement h3{color:var(--navy)}.avatar{flex:none;display:inline-grid;border-radius:50%;overflow:hidden;background:#FFF;border:2px solid #A9D9F2;place-items:center}.avatar img{width:100%;height:100%;object-fit:contain}.avatar-comment{width:40px;height:40px;font-size:25px}.avatar-comment img{transform:scale(.88)}.avatar-48{width:48px;height:48px;font-size:30px}.avatar-64{width:64px;height:64px;font-size:40px}.avatar-fallback{display:grid;place-items:center;width:100%;height:100%;font-size:.55em}.sources{font-size:.78rem;margin:12px 0 0;color:var(--muted)}.sources a{margin-left:5px}.feed-actions{text-align:right;margin:12px 0 0}.share{display:inline-block;border:1px solid var(--navy);border-radius:999px;color:var(--navy);padding:7px 14px;font-size:.79rem;font-weight:700}.archive-cta{text-align:center;margin:32px}.legend{margin:42px 0;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;font-size:.8rem}.legend h2{font-size:1rem;color:var(--navy);margin:0}.legend p{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:9px 0}.footer-banner{display:flex;align-items:center;gap:14px;background:var(--ice-soft);border-radius:14px;padding:16px 20px;margin:40px 0}.footer-banner p{flex:1;margin:0;font-size:.85rem}.footer-banner>a{border-radius:999px;background:var(--red);color:#fff;padding:8px 14px;font-size:.78rem;font-weight:700}.empty{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px;color:var(--muted)}.article-header{height:58px;background:var(--ice-soft);display:flex;align-items:center;justify-content:space-between;padding:0 max(20px,calc((100% - 1080px)/2));font-size:.8rem;border-bottom:1px solid var(--line)}.mini-logo{height:46px;display:flex;align-items:center}.mini-logo img{width:42px;height:42px;object-fit:contain}.article-page{width:min(720px,calc(100% - 28px));margin:44px auto}.article-page h1{color:var(--navy);font:400 1.45rem/1.65 "Kosugi Maru","Hiragino Maru Gothic ProN",sans-serif;margin:18px 0}.article-lead{font-size:1rem;margin:0 0 22px}.article-section{margin:36px 0}.article-section h2{color:var(--navy);border-left:4px solid var(--red);padding-left:12px;font-size:1.08rem}.article-section p{white-space:pre-wrap}.article-page .bingtang-comment{margin:36px 0}.article-actions{border-top:1px solid var(--line);margin-top:38px;padding-top:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.article-actions .sources{margin:0;flex:1}.narrow{width:min(720px,calc(100% - 28px));margin:44px auto}.archive-list{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}.archive-list li+li{border-top:1px solid var(--line)}.archive-list a{display:flex;justify-content:space-between;padding:16px 20px;color:var(--navy)}.about section{margin:34px 0}.about h2{color:var(--navy);font-size:1.08rem}.about .profile{display:flex;align-items:center;gap:16px;background:var(--ice-soft);border-radius:14px;padding:20px}.about .profile p{margin:0}.site-footer{background:var(--navy);color:#fff;padding:24px max(20px,calc((100% - 1080px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px;font-size:.78rem}.site-footer p{margin:0}.site-footer nav{display:flex;gap:16px}.site-footer a{color:#fff}
@media(max-width:640px){.hero:before{font-size:26px;letter-spacing:8px}.hero-inner{width:calc(100% - 28px);min-height:194px}.brand{z-index:1;flex:1;min-width:0;padding:18px 0}.logo img{width:min(245px,64vw)}.date-badge{margin-top:12px;font-size:.7rem}.hero-character{flex:none;width:142px;height:190px;margin-left:-24px}.hero-character img{height:190px;max-width:150px}.main-nav{gap:20px}.main-nav a{font-size:.76rem}.feed,.narrow,.article-page{width:calc(100% - 28px);margin-top:26px}.news-card{padding:21px 14px 17px}.chips time{width:100%;margin-left:0}.source-mix{gap:8px}.feed-details{padding-inline:12px}.bingtang-comment{grid-template-columns:42px minmax(0,1fr);padding:13px 11px}.footer-banner{align-items:flex-start;flex-wrap:wrap}.footer-banner p{min-width:calc(100% - 68px)}.article-header{padding:0 14px}.article-actions{flex-direction:column}.site-footer{align-items:flex-start;flex-direction:column}.article-page h1{font-size:1.24rem}}
.section-icon{display:inline-block;flex:none;width:18px;height:18px;color:var(--ice)}html{font-family:"Zen Kaku Gothic New","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif}.source-mix{background:#EEF8FD}.source-mix strong,.feed-details h3,.bingtang-comment h3,.bingtang-supplement h3,.article-section h2{display:flex;align-items:center;gap:7px}.feed-details h3{color:#12549A}.feed-details section+section{padding-top:14px;border-top:1px solid #E2EFF6}.bingtang-comment{background:#FFF4F3;border-color:#F0D0CD}.bingtang-comment .section-icon-point{color:var(--red)}.bingtang-supplement{background:#EEF8FD}.sources a{color:#1576C9}.share{color:var(--red);border-color:var(--red)}
.bingtang-comment{grid-template-columns:94px minmax(0,1fr);gap:12px;padding:14px 16px}.avatar-comment{width:92px;height:92px;font-size:46px}.avatar-comment img{transform:none}
.about{width:min(820px,calc(100% - 28px))}.about section{margin:38px 0}.about h2{font:400 1.16rem/1.55 "Kosugi Maru","Hiragino Maru Gothic ProN",sans-serif;color:var(--navy);margin:0 0 14px}.about p{margin:0 0 14px}.about-hero{display:grid;grid-template-columns:minmax(240px,290px) minmax(0,1fr);align-items:center;gap:42px}.about-character{align-self:end;display:flex;align-items:flex-end;justify-content:center}.about-character img{display:block;width:100%;max-width:280px;height:420px;object-fit:contain;object-position:center bottom}.about-intro h2{font-size:1.3rem}.about-intro p{font-size:.93rem}.about-section,.about-contact{border-top:1px solid var(--line);padding-top:28px}.about ul{margin:0;padding-left:1.4em}.about li+li{margin-top:8px}.about-contact a{font-weight:700}.site-footer p{max-width:760px}
@media(max-width:640px){.bingtang-comment{position:relative;display:block;padding:12px}.bingtang-comment>.avatar-comment{position:absolute;top:12px;right:12px}.bingtang-comment>div{display:block}.bingtang-comment h3{min-height:76px;padding-right:86px;align-items:flex-start}.avatar-comment{width:76px;height:76px}.about-hero{grid-template-columns:1fr;gap:18px}.about-character img{width:240px;height:350px}.about-intro h2{font-size:1.18rem}.about-section,.about-contact{padding-top:24px}}
`;

main().catch((error) => {
  console.error(`site build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
