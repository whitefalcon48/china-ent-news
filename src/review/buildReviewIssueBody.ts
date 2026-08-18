import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readOrCreateStoredReviewState, writeReviewState } from "./reviewState.js";
import type { ProcessedArticle, ReviewRevisionTrace, ReviewState, SourceRef } from "../types.js";

export function buildReviewIssueBody(state: ReviewState, articles: ProcessedArticle[]) {
  if (!state.articles.length) {
    return `# 📋 ニュースレビュー ${state.date}（0本）

通常のEVS 7点以上の記事はありません。保存済み候補から、EVS 6点の候補を最大3本まで**レビュー専用**で再生成できます。公開は採用判定後です。

\`\`\`text
救済再生成
\`\`\`

- この1行をOWNERとしてコメントすると、保存済みの候補・根拠を使い、台帳とclaim checkを通過した記事だけを保留状態で返信します。
- 7点以上の記事がある日、6点未満しかない日、または過去日の同一topicは救済しません。
- 再生成できない場合も0件のまま、理由だけを返信します。
`;
  }
  const header = `# 📋 ニュースレビュー ${state.date}（${state.articles.length}本）

判定はこのIssueへの返信コメントで。1コメントにまとめて書けます。
**各行の先頭に「-」「・」などの箇条書き記号を付けず、次の形をそのまま入力してください。**

\`\`\`text
1 採用
2 却下 選定 却下理由
3 修正 口調 修正指示
残り採用
\`\`\`

- 形式: \`<番号> 採用\` / \`<番号> 却下 <理由タグ> <コメント>\` / \`<番号> 修正 <理由タグ> <修正指示>\`
- \`残り採用\` は未判定をすべて採用
- 理由タグ: 選定 / 口調 / 用語 / 事実 / 構成 / その他

---`;
  const entries = state.articles.map((reviewArticle) => {
    const article = articles[reviewArticle.index - 1];
    return article ? formatReviewArticle(reviewArticle.index, article) : `## ${reviewArticle.index}. ${reviewArticle.title}\n\n⚠️ 記事データを読み込めませんでした。`;
  });
  return `${header}\n\n${entries.join("\n\n---\n\n")}\n`;
}

export function formatReviewArticle(index: number, article: ProcessedArticle, revised = false) {
  const summary = article.summary;
  if (!summary) return `## ${index}. ⚠️ 要約なし`;
  const sources = summary.source_list.length ? summary.source_list : [{ name: article.raw.sourceName, url: article.raw.url }];
  const relatedSources = (summary.related_sources ?? []).filter((source) => !sources.some((root) => root.name === source.name && (!root.url || !source.url || root.url === source.url)));
  const prefix = revised ? `🔄 修正版 ${index}` : `${index}. 【${summary.badge}｜${summary.category || article.raw.category}｜確度${summary.confidence || article.raw.reliability}】${summary.title_ja || article.raw.title}`;
  const supplement = summary.japan_context_note?.trim();
  const supplementSection = supplement ? `\n\n**ビンタンからの補足**: ${supplement}` : "";
  const reaction = summary.reaction_view?.trim();
  const reactionSection = reaction ? `\n\n**反応・見られ方**: ${reaction}` : "";
  const detailSections = (summary.detail_sections ?? []).map((section) => `### ${section.heading}\n\n${section.body}\n\n根拠claim: ${section.claim_refs.join(", ")}`).join("\n\n");
  return `## ${prefix}

${summary.lead}

${summary.what_happened}${reactionSection}

${detailSections}

**ビンタンの注目ポイント**: ${summary.why_it_matters}${supplementSection}

ソース: ${sources.map(formatSource).join(" / ")}${relatedSources.length ? `\n\n関連角度のソース: ${relatedSources.map(formatSource).join(" / ")}` : ""}`;
}

export function formatReviewRevisionSummary(trace: ReviewRevisionTrace | undefined) {
  if (!trace) return "";
  const mode = trace.mode === "full_rewrite" ? "明示された全体書き直し" : "指定箇所だけの限定パッチ";
  const changes = trace.changes.map((change) => {
    const reason = change.reason || `${preview(change.before)} → ${preview(change.after)}`;
    return `- \`${change.field}\`: ${reason}`;
  });
  return `### 変更範囲

- 適用方式: ${mode}
${changes.join("\n")}
- 非対象フィールド: ${trace.preservation.untouched_fields_exact ? "完全一致を確認" : "全体書き直しのため対象外"}
- source_list / related_sources: ${trace.preservation.source_list_exact && trace.preservation.related_sources_exact ? "保持" : "変更あり"}
- claim refs: ${trace.preservation.claim_refs_before}件 → ${trace.preservation.claim_refs_after}件`;
}

async function main() {
  if (process.env.REVIEW_GATE === "false") return;
  const dataDir = path.resolve(process.env.SITE_DATA_DIR || "data");
  const runDate = process.env.RUN_DATE;
  const reviewDate = process.env.REVIEW_DATE;
  if (runDate && reviewDate && runDate !== reviewDate) {
    throw new Error(`RUN_DATE and REVIEW_DATE must match: ${runDate} !== ${reviewDate}`);
  }
  const date = reviewDate || runDate || await latestDate(dataDir);
  const directory = path.join(dataDir, date);
  const reviewPath = path.join(directory, "review.json");
  const articleFile = (await fs.readdir(directory)).filter((name) => /^articles_\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!articleFile) throw new Error(`articles JSON not found: ${directory}`);
  const articles = JSON.parse(await fs.readFile(path.join(directory, articleFile), "utf8")) as ProcessedArticle[];
  const { state, created } = await readOrCreateStoredReviewState(reviewPath, articles, date);
  if (created) console.log(`review state bootstrap: ${reviewPath} (${state.articles.length} articles)`);
  if (state.issue_number > 0 && process.env.RECREATE_REVIEW_ISSUE !== "true") {
    console.log(`review issue: #${state.issue_number} already exists`);
    return;
  }
  const body = buildReviewIssueBody(state, articles);
  const scratch = path.join(directory, ".review-issue-body.md");
  await fs.writeFile(scratch, body, "utf8");
  try {
    execFileSync("gh", ["label", "create", "daily-review", "--description", "Daily generated-news review", "--color", "C12B23", "--force"], { stdio: "pipe" });
    const url = execFileSync("gh", ["issue", "create", "--title", `📋 ニュースレビュー ${date}`, "--label", "daily-review", "--body-file", scratch], { encoding: "utf8" }).trim();
    const issueNumber = Number(url.match(/\/(\d+)\/?$/)?.[1]);
    if (!issueNumber) throw new Error(`Issue number not found in gh output: ${url}`);
    state.issue_number = issueNumber;
    await writeReviewState(reviewPath, state);
    console.log(`review issue: ${url}`);
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

async function latestDate(dataDir: string) {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const latest = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map((entry) => entry.name).sort().at(-1);
  if (!latest) throw new Error(`review date not found: ${dataDir}`);
  return latest;
}

function formatSource(source: SourceRef) {
  return source.url ? `[${source.name}](${source.url})` : source.name;
}

function preview(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return `「${compact.length > 42 ? `${compact.slice(0, 42)}…` : compact || "空"}」`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.warn(`review issue warning: ${error instanceof Error ? error.message : String(error)}`);
  });
}
