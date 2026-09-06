import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareEvidenceSupplementProposal, summaryHash, type EvidenceSupplementInput } from "./review/prepareEvidenceSupplement.js";
import { prepareStoredArticleRevision, reviseStoredArticle } from "./review/reviseArticle.js";
import type { ProcessedArticle } from "./types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "china-ent-evidence-supplement-"));
try {
  const date = "2026-09-06";
  const directory = path.join(root, date);
  await fs.mkdir(directory, { recursive: true });
  const article = fixtureArticle();
  const other = fixtureArticle();
  other.raw = { ...other.raw, title: "別記事", url: "https://example.com/other" };
  other.summary = { ...other.summary!, title_ja: "別記事", what_happened: "別記事の本文。" };
  const articlePath = path.join(directory, `articles_${date}.json`);
  await fs.writeFile(articlePath, `${JSON.stringify([article, other], null, 2)}\n`);
  await fs.writeFile(path.join(directory, "fact_ledger_2026-09-06.json"), JSON.stringify({ date, ledgers: [{ topic_key: "交锋", ledger: article.generationMeta!.ledger }] }));
  await fs.writeFile(path.join(directory, "review.json"), JSON.stringify({ date, status: "pending", issue_number: 83, articles: [
    { index: 1, topic_key: "交锋", title: "交鋒", status: "pending", reason_tag: "", comment: "", revision_count: 0, article_id: "a-test", current_version: 1, publication: { slug: "1" } },
    { index: 2, topic_key: "別", title: "別記事", status: "approved", reason_tag: "", comment: "", revision_count: 0, article_id: "a-other", current_version: 1, publication: { slug: "other", queued_at: "2026-09-06T00:00:00Z" } }
  ] }));
  const input = request(article);
  const guardDirectory = path.join(root, "2026-09-07");
  await fs.mkdir(guardDirectory, { recursive: true });
  const guardedArticle = structuredClone(article);
  guardedArticle.generationMeta!.review_supplements = [{
    term: input.supplement.term, definition_ja: input.supplement.definition_ja, source_url: input.supplement.source_url,
    source_name: input.supplement.source_name, source_title: "公式説明", source_published_date: "2020-01-01",
    fetched_at: "2026-09-06T00:00:00Z", source_quote: input.supplement.source_quote, subject_quote: input.supplement.subject_quote,
    body_sha256: "a".repeat(64), evidence_ref: "E2", claim_ref: "C3", reason: input.supplement.reason,
    reviewed_by: input.supplement.reviewed_by, verification: "operator_reviewed_exact_quotes"
  }];
  const guardArticlePath = path.join(guardDirectory, "articles_2026-09-07.json");
  await fs.writeFile(guardArticlePath, `${JSON.stringify([guardedArticle], null, 2)}\n`);
  await fs.writeFile(path.join(guardDirectory, "fact_ledger_2026-09-07.json"), JSON.stringify({ date: "2026-09-07", ledgers: [{ topic_key: "交锋", ledger: guardedArticle.generationMeta!.ledger }] }));
  const guardBefore = await fs.readFile(guardArticlePath, "utf8");
  const rewriteInstruction = "記事全体を書き直してください。";
  await assert.rejects(() => prepareStoredArticleRevision(guardDirectory, 1, rewriteInstruction, "構成"), /追加出典を含む記事の全文書き直しは未対応/);
  await assert.rejects(() => reviseStoredArticle(guardDirectory, 1, rewriteInstruction, "構成"), /追加出典を含む記事の全文書き直しは未対応/);
  assert.equal(await fs.readFile(guardArticlePath, "utf8"), guardBefore, "補足出典の記事は全文書き直し前に停止し、記事を変更しない");
  const before = await fs.readFile(articlePath, "utf8");
  const mockFetch = async () => ({ ok: true as const, document: { requested_url: input.supplement.source_url, final_url: input.supplement.source_url, title: "公式説明", text: `${input.supplement.subject_quote} ${input.supplement.source_quote}`, published_date: "2020-01-01", fetched_at: "2026-09-06T00:00:00Z", extraction_quality: { status: "usable" as const, raw_chars: 80, meaningful_chars: 80, sentence_count: 2, boilerplate_ratio: 0, factual_anchor_count: 2 }, content_type: "text/html" } });
  const dry = await prepareEvidenceSupplementProposal(input, { dataDir: root, fetchDocument: mockFetch });
  assert.equal(dry.written, false);
  assert.equal(await fs.readFile(articlePath, "utf8"), before, "dryrun must not alter article bytes");
  assert.match(dry.output, /追加出典あり/);
  assert.match(dry.output, /確認担当: codex/);
  await assert.rejects(() => prepareEvidenceSupplementProposal(input, { dataDir: root, write: true, fetchDocument: mockFetch }), /confirm-source-reviewed/);
  const saved = await prepareEvidenceSupplementProposal(input, { dataDir: root, write: true, confirmSourceReviewed: true, fetchDocument: mockFetch });
  assert.equal(saved.written, true);
  assert.equal(await fs.readFile(articlePath, "utf8"), before, "proposal write must preserve article bytes");
  const review = JSON.parse(await fs.readFile(path.join(directory, "review.json"), "utf8"));
  assert.equal(review.articles[0].status, "proposal_pending");
  assert.ok(review.articles[0].pending_proposal_id);
  const revisions = JSON.parse(await fs.readFile(path.join(directory, "revisions.json"), "utf8"));
  assert.equal(revisions.articles["a-test"].proposals.length, 1);
  assert.equal(revisions.articles["a-test"].proposals[0].article_state.generationMeta.review_supplements.length, 1);
  await assert.rejects(() => prepareEvidenceSupplementProposal(input, { dataDir: root, write: true, confirmSourceReviewed: true, fetchDocument: mockFetch }), /既存の修正案/);
  await assert.rejects(() => prepareEvidenceSupplementProposal({ ...input, base_summary_sha256: "0".repeat(64) }, { dataDir: root, fetchDocument: mockFetch }), /base_summary_sha256/);
  // Use the ordinary review-apply entrypoint in a separate process. The test
  // fixture has no Issue so that its normal reply step cannot call GitHub.
  review.issue_number = 0;
  await fs.writeFile(path.join(directory, "review.json"), JSON.stringify(review));
  const apply = spawnSync("npm.cmd", ["exec", "--", "tsx", "src/review/applyReview.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, REVIEW_GATE: "true", REVIEW_COMMENT: "1 適用", REVIEW_ISSUE_NUMBER: "0", REVIEW_DATE: date, SITE_DATA_DIR: root },
    shell: process.platform === "win32",
    encoding: "utf8"
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  const appliedArticles = JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[];
  const appliedArticle = appliedArticles[0];
  assert.equal(appliedArticle.generationMeta?.ledger?.claims.at(-1)?.text, input.supplement.definition_ja, "通常のreview applyでも追加claimを保持する");
  assert.equal(appliedArticle.summary?.related_sources.at(-1)?.url, input.supplement.source_url, "通常のreview applyでも追加出典を保持する");
  assert.equal(appliedArticle.generationMeta?.ledger?.claims.some((claim) => claim.text === input.supplement.definition_ja), true, "追加claimを再読込する");
  assert.equal(appliedArticles[1].summary?.what_happened, "別記事の本文。", "他記事を変更しない");
  const appliedReview = JSON.parse(await fs.readFile(path.join(directory, "review.json"), "utf8"));
  assert.equal(appliedReview.articles[0].status, "revised_pending");
  assert.equal(appliedReview.articles[1].publication.slug, "other", "他記事の公開状態を保持する");
  const reverted = spawnSync("npm.cmd", ["exec", "--", "tsx", "src/review/applyReview.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, REVIEW_GATE: "true", REVIEW_COMMENT: "1 初版に戻す", REVIEW_ISSUE_NUMBER: "0", REVIEW_DATE: date, SITE_DATA_DIR: root },
    shell: process.platform === "win32",
    encoding: "utf8"
  });
  assert.equal(reverted.status, 0, reverted.stderr || reverted.stdout);
  const initialArticle = (JSON.parse(await fs.readFile(articlePath, "utf8")) as ProcessedArticle[])[0];
  assert.equal(initialArticle.generationMeta?.ledger?.claims.some((claim) => claim.text === input.supplement.definition_ja), false, "初版に戻すと補足claimを残さない");
  assert.equal(initialArticle.summary?.related_sources.some((source) => source.url === input.supplement.source_url), false, "初版に戻すと補足出典を残さない");
  await assert.rejects(() => prepareEvidenceSupplementProposal({ ...input, date: "../2026-09-06" }, { dataDir: root, fetchDocument: mockFetch }), /YYYY-MM-DD/);
  console.log("evidence supplement proposal tests passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

function fixtureArticle(): ProcessedArticle {
  const summary: any = {
    title_ja: "交鋒", badge: "NEWS", lead: "lead",
    what_happened: "国家安全部が主導して制作され、中央広播電視総台などが制作に関わる。",
    reaction_view: "", why_it_matters: "注目ポイント！", editor_comment: "", japan_context_note: "", category: "ドラマ", confidence: "B", source_type: "media_report", published_date: "2026-09-01", event_date: "2026-09-01", freshness_label: "recent", newsworthiness_score: 1, japan_visibility: "unknown", japan_gap: "unknown", context_value: "low", sns_heat: "none", source_count: 1, source_list: [{ name: "元記事", url: "https://example.com/root" }], related_sources: [], has_official_source: false, has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "verified", topic_key: "交锋", main_entities: { people: [], works: ["交锋"], organizations: ["国家安全部"] }, tags: [], publish_priority: "medium", publish_reason: "", claim_refs: { what_happened: ["C2"], why_it_matters: [], reaction_view: [], japan_context_note: [] }, detail_sections: []
  };
  const topic: any = { topic_key: "交锋", title_hint: "交鋒", event_sentence: "交鋒", search_queries: [], seed_source: "llm", seed_confidence: 1, topic_type: "drama_production", freshness_label: "recent", published_date_range: { earliest: "2026-09-01", latest: "2026-09-01" }, source_count: 1, source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 }, evidence_articles: [] };
  const ledger: any = { topic_key: "交锋", claims: [{ id: "C2", type: "verified_fact", text: "国家安全部が主導して制作", evidence_refs: ["E1"], entities: ["国家安全部"], numbers: [], quote_zh: "国家安全部", anchor: true, scope: "root_event", editorial_role: "other", angle_kind: "other" }], terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: [], evidence_roles: { E1: "root_corroboration" }, evidence_quality: [] };
  return { raw: { title: "交鋒", url: "https://example.com/root", sourceName: "元記事" } as any, summary, topic, generationMeta: { topic_key: "交锋", ledger_used: true, ledger_fallback_reason: "", ledger } as any };
}

function request(article: ProcessedArticle): EvidenceSupplementInput {
  const before = "国家安全部が主導して制作され、中央広播電視総台などが制作に関わる。";
  const after = "国家安全部が主導して制作された。国家安全部は、中国でスパイ対策や国家安全に関する情報活動を担う機関だ。";
  return { date: "2026-09-06", issue_number: 83, index: 1, article_id: "a-test", topic_key: "交锋", base_summary_sha256: summaryHash(article.summary), supplement: { instruction: `何が起きたかの「${before}」を「${after}」に置き換えてください。`, term: "国家安全部", definition_ja: "国家安全部は、中国でスパイ対策や国家安全に関する情報活動を担う機関だ。", source_url: "https://example.gov.cn/role", source_name: "公式", source_quote: "国家安全机关是反间谍工作的主管机关", subject_quote: "国家安全部是1983年组建的。", reason: "補足", reviewed_by: "codex", before, after, existing_claim_refs: ["C2"] } };
}
