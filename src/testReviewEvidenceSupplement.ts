import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchIntakeDocument } from "./intake/fetchIntakeDocument.js";
import { prepareEvidenceSupplement, type EvidenceSupplementRequest } from "./review/evidenceSupplement.js";
import type { FactLedger, ProcessedArticle, TopicCandidate } from "./types.js";

const before = "国家安全部が主導して制作され、中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視などが制作に関わる。";
const definition = "国家安全部は、中国でスパイ対策や国家安全に関する情報活動を担う機関だ。";
const after = `国家安全部が主導して制作された。${definition}`;
const body = "国家安全部は国家の安全を守り、スパイ対策と国家安全に関する情報活動を担う。国家安全部の職責を説明する公式資料。";

const request: EvidenceSupplementRequest = {
  instruction: "what_happened を修正し、制作団体の列挙を削除して国家安全部の説明を追加してください。",
  term: "国家安全部",
  definition_ja: definition,
  source_url: "https://www.mss.gov.cn/official-duty",
  source_name: "国家安全部",
  source_quote: "国家安全部は国家の安全を守り、スパイ対策と国家安全に関する情報活動を担う。",
  subject_quote: "国家安全部は国家の安全を守り、",
  reason: "制作団体の列挙を削除し、出典付きの用語説明を追加",
  reviewed_by: "codex-operator",
  before,
  after,
  existing_claim_refs: ["C2"]
};

const input = article();
const snapshot = structuredClone(input);
const result = await prepareEvidenceSupplement(input, ledger(), request, { fetchDocument: successFetch(body) });
assert.equal(result.article.summary?.what_happened, after);
assert.equal(result.summary, request.reason);
assert.deepEqual(input, snapshot, "入力articleを変更しない");
const expectedSummary = structuredClone(snapshot.summary!);
expectedSummary.what_happened = after;
expectedSummary.related_sources.push({ name: request.source_name, url: request.source_url });
expectedSummary.claim_refs.what_happened.push("C5");
assert.deepEqual(result.article.summary, expectedSummary, "what_happenedと追加関連出典以外のsummaryを完全保持する");
assert.equal(result.article.summary?.related_sources.at(-1)?.url, request.source_url);
assert.equal(result.trace.preservation.related_sources_exact, false);
assert.equal(result.article.topic?.source_count, snapshot.topic?.source_count, "related angleはroot source_countへ昇格しない");
assert.deepEqual(result.article.topic?.source_mix, snapshot.topic?.source_mix);
assert.equal(result.article.topic?.evidence_articles.length, snapshot.topic?.evidence_articles.length);
assert.equal(result.article.topic?.related_evidence_articles?.at(-1)?.url, request.source_url);
assert.equal(result.article.generationMeta?.ledger?.claims.at(-1)?.id, "C5");
assert.equal(result.article.generationMeta?.ledger?.claims.at(-1)?.scope, "related_angle");
assert.equal(result.article.generationMeta?.ledger?.evidence_roles?.E3, "related_angle");
assert.equal(result.article.generationMeta?.review_supplements?.[0]?.body_sha256, createHash("sha256").update(body, "utf8").digest("hex"));
assert.equal(result.supplement.source_quote, request.source_quote);
result.article.generationMeta!.ledger!.claims[0]!.text = "returned-only";
result.article.generationMeta!.review_supplements![0]!.source_name = "returned-only";
result.article.topic!.related_evidence_articles![0]!.key_points[0] = "returned-only";
assert.deepEqual(input, snapshot, "返却articleのnested meta/sourceを変更しても入力articleへaliasしない");

await rejects({ ...request, source_quote: "本文にない引用" }, successFetch(body));
await rejects({ ...request, subject_quote: "別の機関" }, successFetch(body));
await rejects({ ...request, subject_quote: "国家安全部は国家の安全を守り。スパイ対策" }, successFetch(body), "句読点を消した疑似一致は通さない");
await rejects({ ...request, source_url: "https://example.com/official" }, successFetch(body));
await rejects({ ...request, source_url: "http://127.0.0.1/official" }, successFetch(body));
await rejects(request, async () => ({ ok: false, error: "fetch_failed" }));
await rejects({ ...request, before: "国家安全部" }, successFetch(body));
await rejects({ ...request, instruction: "lead を修正してください。" }, successFetch(body));
await rejects({ ...request, after: `${after} 2つの部門がある。` }, successFetch(body));
await rejects({ ...request, existing_claim_refs: ["C999"] }, successFetch(body));
await rejects({ ...request, reviewed_by: "codex@example" }, successFetch(body));
const queryDuplicate = article();
queryDuplicate.summary!.related_sources = [{ name: "既存公式", url: "https://www.mss.gov.cn/official-duty?from=old#section" }];
await assert.rejects(() => prepareEvidenceSupplement(queryDuplicate, ledger(), { ...request, source_url: "https://www.mss.gov.cn/official-duty?from=new" }, { fetchDocument: successFetch(body) }), /同一URL/u);

console.log("review evidence supplement tests passed");

async function rejects(next: EvidenceSupplementRequest, fetchDocument: typeof fetchIntakeDocument, _label = "") {
  await assert.rejects(() => prepareEvidenceSupplement(article(), ledger(), next, { fetchDocument }));
}

function successFetch(text: string): typeof fetchIntakeDocument {
  return async () => ({
    ok: true,
    document: {
      requested_url: request.source_url,
      final_url: request.source_url,
      title: "国家安全部の職責",
      text,
      published_date: "2026-09-01",
      extraction_method: "article",
      extraction_quality: { status: "usable", raw_chars: text.length, meaningful_chars: text.length, sentence_count: 2, boilerplate_ratio: 0, factual_anchor_count: 2 },
      fetched_at: "2026-09-06T00:00:00.000Z",
      content_type: "text/html"
    }
  });
}

function ledger(): FactLedger {
  return {
    topic_key: "交鋒",
    claims: ["C1", "C2", "C3", "C4"].map((id) => ({ id, type: "verified_fact" as const, text: "国家安全部が主導して制作された。", evidence_refs: ["E2"], source_name: "新京報", entities: ["国家安全部"], numbers: [], quote_zh: "国家安全部主导制作", anchor: true, scope: "root_event" as const, angle_kind: "other" as const, editorial_role: "other" as const })),
    terms: [],
    japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
    unresolved: [],
    evidence_roles: { E2: "root_corroboration" },
    evidence_quality: [{ evidence_ref: "E2", classification: "editorial_media", usable_for_verified_facts: true, reason: "fixture" }]
  };
}

function article(): ProcessedArticle {
  const topic: TopicCandidate = {
    topic_key: "交鋒", title_hint: "交鋒", event_sentence: "交鋒が放送される", search_queries: ["交鋒"], seed_source: "llm", seed_confidence: 1,
    topic_type: "release", freshness_label: "today", published_date_range: { earliest: "2026-09-01", latest: "2026-09-01" }, source_count: 1,
    source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
    evidence_articles: [{ title: "交鋒", url: "https://bjnews.com/article", source_name: "新京報", source_type: "media_report", published_date: "2026-09-01", freshness_label: "today", article_type: "news_event", reliability: "B", key_points: [before] }],
    main_entities: { people: [], works: ["交鋒"], organizations: ["国家安全部"], events: [] }, signals: { has_official_source: false, has_media_context: true, has_data_signal: false, has_hot_search_signal: false, has_multiple_sources: false }, newsworthiness_score: 60, japan_gap: "medium", context_value: "medium", publish_priority: "medium", selection_reason: "fixture", caution_note: ""
  };
  return {
    raw: { title: "交鋒", url: "https://bjnews.com/article", sourceName: "新京報", sourceUrl: "https://bjnews.com", category: "映画", reliability: "B", sourceType: "media_report", articleType: "news_event", skipReason: "", topicKey: "交鋒", mainEntities: { people: [], works: ["交鋒"], organizations: ["国家安全部"] }, relatedSources: [] },
    topic,
    summary: { title_ja: "『交鋒』", badge: "NEWS", lead: "ドラマの放送が決まった。", what_happened: before, reaction_view: "", why_it_matters: "", editor_comment: "", japan_context_note: "", category: "映画", confidence: "B", source_type: "media_report", published_date: "2026-09-01", event_date: "", freshness_label: "today", newsworthiness_score: 60, japan_visibility: "unknown", japan_gap: "medium", context_value: "medium", sns_heat: "none", source_count: 1, source_list: [{ name: "新京報", url: "https://bjnews.com/article" }], has_official_source: false, has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "verified", topic_key: "交鋒", main_entities: { people: [], works: ["交鋒"], organizations: ["国家安全部"] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "", claim_refs: { what_happened: ["C1", "C2", "C3", "C4"], why_it_matters: [], reaction_view: [], japan_context_note: [] }, detail_sections: [] }
  };
}
