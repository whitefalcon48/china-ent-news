import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function main() {
  const workflow = await fs.readFile(".github/workflows/manual-intake.yml", "utf8");
  assert.match(workflow, /issue_comment:\r?\n\s+types: \[created\]/u);
  for (const required of [
    "github.event.comment.author_association == 'OWNER'",
    "contains(github.event.issue.labels.*.name, 'manual-news-intake')",
    "vars.NEWS_INTAKE_ISSUE_NUMBER",
    "group: china-ent-news-production",
    "node --import tsx src/intake/runManualIntake.ts",
    "DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}",
    "SERPER_API_KEY: ${{ secrets.SERPER_API_KEY }}",
    "node --import tsx src/intake/linkManualReviewIssue.ts",
    "gh issue edit \"$REVIEW_ISSUE_NUMBER\" --add-label manual-news-review"
  ]) {
    assert.ok(workflow.includes(required), `manual intake workflow is missing: ${required}`);
  }

  const initialCommit = workflow.indexOf("Commit intake state before review creation");
  const reviewCreation = workflow.indexOf("Find or create dedicated review issue");
  const linking = workflow.indexOf("Link new review issue to intake state");
  const linkedCommit = workflow.indexOf("Commit linked review state");
  const labeling = workflow.indexOf("Enable review comment handling");
  assert.ok(initialCommit < reviewCreation && reviewCreation < linking && linking < linkedCommit && linkedCommit < labeling);
  assert.equal((workflow.match(/for attempt in 1 2 3;/gu) ?? []).length, 2);
  const issueCreateLine = workflow.split(/\r?\n/u).find((line) => line.includes("gh issue create")) ?? "";
  assert.ok(issueCreateLine && !issueCreateLine.includes("--label"), "review Issue must be created without a label");
  assert.match(workflow, /REVIEW_TITLE: "持ち込みニュース レビュー #\$\{\{/u);
  assert.match(workflow, /LEDGER_AI_PROVIDER: deepseek/u, "持ち込み用の事実台帳は独立したDeepSeek経路を使う");
  assert.match(workflow, /LEDGER_AI_MODEL: deepseek-v4-pro/u, "持ち込み用の事実台帳はDeepSeek Proを使う");
  assert.match(workflow, /AI_PROVIDER: deepseek/u, "持ち込み用の下書き本文もDeepSeek経路を使う");
  assert.match(workflow, /COMMENT_AI_PROVIDER: deepseek/u, "持ち込み用のコメントもDeepSeek経路を使う");
  assert.match(workflow, /COMMENT_AI_MODEL: deepseek-v4-pro/u, "持ち込み用のコメントはDeepSeek Proを使う");
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/u, "Gemini用の認証情報を持ち込み処理へ渡す");
  assert.match(workflow, /持ち込みニュースの処理に失敗しました。詳細はActionsログを確認してください。[\s\S]*?exit 1/u);
  assert.match(workflow, /steps\.review\.outputs\.needs_link == 'false'[\s\S]*?steps\.label_review\.outcome == 'success'/u, "既存レビューIssueの再実行でもラベルを復旧する");
  console.log("manual intake workflow tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
