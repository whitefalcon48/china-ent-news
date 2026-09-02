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

- この1行をOWNERとしてコメントすると、保存済みの候補と根拠を確認した記事だけを、保留状態で返信します。
- 7点以上の記事がある日、6点未満しかない日、または過去日の同一topicは救済しません。
- 再生成できない場合も0件のまま、理由だけを返信します。
`;
  }
  const header = `# 📋 ニュースレビュー ${state.date}（${state.articles.length}本）

判定はこのIssueへの返信コメントで。1記事分だけ、または複数記事分をまとめて送れます。未記載の記事はそのままです。
番号から始まる行を、必要なだけ入力してください。行頭の箇条書き記号があっても受け付けます。

\`\`\`text
1 採用
2 保留 あとで確認
3 修正 口調 修正指示
4 修正 初稿の雰囲気を保ち、作品名だけ直す
5 適用
6 適用 採用
7 やめる
8 修正 追加指示
残り採用
\`\`\`

- 形式: \`<番号> 採用\` / \`<番号> 保留 <理由（任意）>\` / \`<番号> 却下 <理由タグ（任意）> <コメント>\` / \`<番号> 修正 <修正指示>\`
- 修正案が表示されている記事は、\`<番号> 適用\` / \`<番号> 適用 採用\` / \`<番号> やめる\` / \`<番号> 修正 <追加指示>\` で操作できます。
- \`残り採用\` は未判定をすべて採用
- 理由タグ（任意）: 選定 / 口調 / 用語 / 事実 / 構成 / その他

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
  const detailSections = (summary.detail_sections ?? []).map((section) => `### ${section.heading}\n\n${section.body}`).join("\n\n");
  return `## ${prefix}

${summary.lead}

${summary.what_happened}${reactionSection}

${detailSections}

**ビンタンの注目ポイント**: ${summary.why_it_matters}${supplementSection}

ソース: ${sources.map(formatSource).join(" / ")}${relatedSources.length ? `\n\n関連角度のソース: ${relatedSources.map(formatSource).join(" / ")}` : ""}`;
}

export function formatReviewRevisionSummary(trace: ReviewRevisionTrace | undefined) {
  if (!trace) return "";
  const changes = trace.changes.map((change) => {
    return `- ${humanField(change.field)}: ${preview(change.before)} → ${preview(change.after)}${change.reason ? `（${change.reason}）` : ""}`;
  });
  return `### 修正した箇所

${changes.join("\n")}
- 変更していない本文・ソース: ${trace.preservation.untouched_fields_exact && trace.preservation.source_list_exact && trace.preservation.related_sources_exact ? "そのまま保持" : "確認が必要"}
- 削除した情報: なし（削除がある場合は修正案に明記）`;
}

export type ReviewProposalChange = {
  field?: string;
  before?: string;
  after?: string;
  reason?: string;
  evidence_claim_refs?: string[];
};

export type ReviewProposal = {
  instruction?: string;
  summary?: string;
  evidence_urls?: string[];
  status?: string;
  trace?: { changes?: ReviewProposalChange[] };
  changes?: ReviewProposalChange[];
  untouched?: string[];
  deleted_information?: string[];
};

/** 修正案を人向けに表示する。内部のclaim IDや実装方式は表示しない。 */
export function formatReviewProposalSummary(proposal: ReviewProposal | undefined) {
  if (!proposal) return "";
  const changes = proposal.trace?.changes ?? proposal.changes ?? [];
  const lines = ["### 修正案", ""];
  if (proposal.instruction?.trim()) lines.push(`指示: ${proposal.instruction.trim()}`, "");
  if (proposal.summary?.trim()) lines.push(proposal.summary.trim(), "");
  lines.push("変更する箇所:");
  if (changes.length) {
    for (const change of changes) {
      lines.push(`- ${humanField(change.field)}: ${preview(change.before || "")} → ${preview(change.after || "")}${change.reason ? `（${change.reason}）` : ""}`);
    }
  } else {
    lines.push("- 変更箇所を確認できませんでした。修正案を作り直してください。");
  }
  lines.push("", `変更しない部分: ${proposal.untouched?.length ? proposal.untouched.join("、") : "上記以外の本文・注目ポイント・ソース"}`);
  lines.push(`削除情報: ${proposal.deleted_information?.length ? proposal.deleted_information.join("、") : "なし"}`);
  if (proposal.evidence_urls?.length) {
    lines.push("", "根拠URL:", ...proposal.evidence_urls.map((url) => `- ${url}`));
  }
  return lines.join("\n");
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

function humanField(field?: string) {
  const labels: Record<string, string> = {
    title_ja: "タイトル",
    lead: "リード",
    what_happened: "何が起きたか",
    reaction_view: "反応・見られ方",
    why_it_matters: "注目ポイント",
    japan_context_note: "補足"
  };
  if (!field) return "本文";
  const detail = field.match(/^detail_sections\.\d+\.(heading|body)$/);
  return detail ? `詳しく見る（${detail[1] === "heading" ? "見出し" : "本文"}）` : labels[field] || "本文";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.warn(`review issue warning: ${error instanceof Error ? error.message : String(error)}`);
  });
}
