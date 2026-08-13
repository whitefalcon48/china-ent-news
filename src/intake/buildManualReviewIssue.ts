import { formatReviewArticle } from "../review/buildReviewIssueBody.js";
import type { FactLedger, ProcessedArticle } from "../types.js";

export function buildManualReviewIssue(input: {
  commentId: string;
  intakeUrl: string;
  note: string;
  article: ProcessedArticle;
  ledger: FactLedger;
}) {
  const title = input.article.summary?.title_ja || input.article.raw.title;
  const xText = buildSuggestedXText(input.article);
  const note = input.note ? `\n\n持ち込み理由: ${input.note}` : "";
  const rootClaims = input.ledger.claims.filter((claim) => claim.scope !== "related_angle");
  const depth = input.article.generationMeta?.article_depth;
  const depthLine = depth
    ? `\n- 根拠カバレッジ: ${depth.used_claims}/${depth.eligible_claims} claim（${Math.round(depth.coverage_ratio * 100)}%） / 詳細 ${depth.detail_sections}節 / 重要数字 ${depth.used_number_claims}/${depth.important_number_claims} claim`
    : "";
  return `# 持ち込みニュース レビュー: ${title}

常設IssueのOWNERコメント #${input.commentId} から即時生成しました。まだ公開されません。

- 入力URL: ${input.intakeUrl}${note}
- 事実台帳: root claim ${rootClaims.length}件 / claim ref付き本文を生成済み${depthLine}
- 操作: \`1 採用\` / \`1 却下\` / \`1 修正 <理由>\`

---

${formatReviewArticle(1, input.article)}

---

## X用文面（採用後に使用）

${xText}
`;
}

export function buildSuggestedXText(article: ProcessedArticle) {
  const summary = article.summary;
  if (!summary) return "";
  const source = summary.source_list[0]?.url || article.raw.url;
  return `${summary.title_ja}\n${summary.lead}\n\n${source}`.slice(0, 280);
}
