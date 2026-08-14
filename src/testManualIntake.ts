import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buildManualReviewIssue } from "./intake/buildManualReviewIssue.js";
import { assessArticleDepth, getArticleDepthRequirements } from "./articleDepth.js";
import { assessLedgerAdequacy } from "./ledgerAdequacy.js";
import { enforceStandardArticleFormat, ensureCanonicalPersonName, repairManualFactSectionGrounding } from "./summarizeWithGemini.js";
import { fetchIntakeDocument, isPrivateAddress } from "./intake/fetchIntakeDocument.js";
import { updateManualIntakeState, writeManualIntakeState } from "./intake/intakeState.js";
import { parseManualIntake } from "./intake/parseManualIntake.js";
import { assessManualEvidenceAdequacy, findRecentIntakeDocument } from "./intake/processManualIntake.js";
import type { FactLedger, ProcessedArticle } from "./types.js";

async function main() {
  const parsed = parseManualIntake({ id: 42, authorLogin: "owner", authorAssociation: "OWNER", body: "https://example.com/news\n速報なので確認" });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.note, "速報なので確認");
  assert.equal(parseManualIntake({ id: 42, authorLogin: "member", authorAssociation: "MEMBER", body: "https://example.com" }).error, "not_owner");
  assert.equal(parseManualIntake({ id: 42, authorLogin: "owner", authorAssociation: "OWNER", body: "https://a.example https://b.example" }).error, "expected_exactly_one_url");
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("192.0.0.1"), true, "IPv4 special-use range");
  assert.equal(isPrivateAddress("198.18.0.1"), true, "IPv4 benchmark range");
  assert.equal(isPrivateAddress("::ffff:192.168.1.1"), true, "IPv4-mapped IPv6 private range");
  assert.equal(isPrivateAddress("2001:db8::1"), true, "IPv6 documentation range");
  const sparseAdequacy = assessManualEvidenceAdequacy({
    requested_url: "https://example.com", final_url: "https://example.com", title: "短い記事",
    text: "2026年暑期档の票房は92億元を超えた。120部以上が上映された。", published_date: "2026-08-14",
    extraction_quality: { status: "limited", raw_chars: 42, meaningful_chars: 42, sentence_count: 2, boilerplate_ratio: 0, factual_anchor_count: 4 },
    fetched_at: "2026-08-14T00:00:00Z", content_type: "text/html"
  }, { error: "source_expansion_failed", graceful_fallback: true });
  assert.equal(sparseAdequacy.passed, false, "limitedな起点だけで周辺報道が確認できない場合は生成へ進めない");
  const unsafe = await fetchIntakeDocument("http://127.0.0.1/news", { lookupHost: async () => ["127.0.0.1"] });
  assert.deepEqual(unsafe, { ok: false, error: "unsafe_url" });
  const fetched = await fetchIntakeDocument("https://news.example/article", {
    lookupHost: async () => ["8.8.8.8"],
    fetchImpl: async () => new Response("<html><title>記事</title><article>これは持ち込みニュース用に十分な長さを持つ本文です。確認できた事実だけを使います。</article></html>", { headers: { "content-type": "text/html" } })
  });
  assert.equal(fetched.ok, true);
  let retryCount = 0;
  const retried = await fetchIntakeDocument("https://retry.example/article", {
    lookupHost: async () => ["93.184.216.34", "93.184.216.35"],
    requestImpl: (options, callback) => {
      const request = new EventEmitter() as http.ClientRequest;
      Object.assign(request, {
        setTimeout: () => request,
        destroy: (error?: Error) => {
          if (error) queueMicrotask(() => request.emit("error", error));
          return request;
        },
        end: () => {
          retryCount += 1;
          if (retryCount === 1) {
            queueMicrotask(() => request.emit("error", new Error("temporary network failure")));
          } else {
            const response = new PassThrough() as unknown as http.IncomingMessage;
            Object.assign(response, { statusCode: 200, headers: { "content-type": "text/html" } });
            queueMicrotask(() => {
              callback(response);
              (response as unknown as PassThrough).end("<html><title>再試行</title><article>2026年8月14日の最初の接続だけが失敗しました。同じ安全検査済みホストへ2回目の接続を行い、本文を取得できることを確認します。</article></html>");
            });
          }
          return request;
        }
      });
      return request;
    }
  });
  assert.equal(retried.ok, true, `temporary fetch failure is retried: ${JSON.stringify(retried)}`);
  assert.equal(retryCount, 2);
  const redirectedToPrivate = await fetchIntakeDocument("https://news.example/article", {
    lookupHost: async (host) => host === "news.example" ? ["8.8.8.8"] : ["127.0.0.1"],
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })
  });
  assert.deepEqual(redirectedToPrivate, { ok: false, error: "unsafe_url" });

  const requests: Array<{ hostname?: string; host?: string; servername?: string; address: string; family: number }> = [];
  let requestCount = 0;
  const pinned = await fetchIntakeDocument("https://rebind.example/article", {
    lookupHost: async (host) => host === "rebind.example" ? ["93.184.216.34"] : ["1.1.1.1"],
    requestImpl: (options, callback) => {
      const lookup = options.lookup as unknown as (hostname: string, lookupOptions: unknown, done: (error: Error | null, address: string, family: number) => void) => void;
      let resolved = "";
      let family = 0;
      lookup(options.hostname || "", {}, (_error, address, resultFamily) => { resolved = address; family = resultFamily; });
      const hostHeader = (options.headers as Record<string, string | number | string[] | undefined> | undefined)?.host;
      requests.push({
        hostname: options.hostname ?? undefined,
        host: typeof hostHeader === "string" ? hostHeader : undefined,
        servername: options.servername,
        address: resolved,
        family
      });
      const response = new PassThrough() as unknown as http.IncomingMessage;
      const isRedirect = requestCount === 0;
      Object.assign(response, isRedirect
        ? { statusCode: 302, headers: { location: "https://second.example/final" } }
        : { statusCode: 200, headers: { "content-type": "text/html" } });
      requestCount += 1;
      queueMicrotask(() => {
        callback(response);
        (response as unknown as PassThrough).end(isRedirect ? "" : "<html><title>記事</title><article>これは公開IPへ固定して接続することを確認するための十分に長いテスト本文です。DNSの再解決を使わず、リダイレクト先でも検査済みアドレスへ接続できることを確認します。手動ニュースの取得で内部ネットワークに到達しないことが重要です。</article></html>");
      });
      const request = new EventEmitter() as http.ClientRequest;
      Object.assign(request, {
        setTimeout: () => request,
        destroy: (error?: Error) => {
          if (error) queueMicrotask(() => request.emit("error", error));
          return request;
        },
        end: () => request
      });
      return request;
    }
  });
  assert.equal(pinned.ok, true, `production request hook path succeeds: ${JSON.stringify(pinned)}`);
  assert.deepEqual(requests.map((item) => item.address), ["93.184.216.34", "1.1.1.1"], "each redirect is pinned to its freshly validated address");
  assert.deepEqual(requests.map((item) => item.hostname), ["rebind.example", "second.example"], "original hostname remains available for virtual hosting");
  assert.deepEqual(requests.map((item) => item.host), ["rebind.example", "second.example"], "Host header is the original hostname, not the pinned IP");
  assert.deepEqual(requests.map((item) => item.servername), ["rebind.example", "second.example"], "SNI is the original hostname, not the pinned IP");
  const nonStandardPort = await fetchIntakeDocument("https://news.example:444/article", {
    lookupHost: async () => ["8.8.8.8"],
    requestImpl: () => { throw new Error("must not request non-standard port"); }
  });
  assert.deepEqual(nonStandardPort, { ok: false, error: "unsafe_url" });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manual-intake-"));
  try {
    const state = { version: 1 as const, comment_id: "42", source_url: "https://example.com/news", note: "", status: "received" as const, created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z" };
    await writeManualIntakeState(state, root);
    const updated = await updateManualIntakeState(state, { status: "failed", error: "fetch:http_500" }, root);
    assert.equal(updated.status, "failed");
    const cachedDirectory = path.join(root, "manual-intake", "41");
    await fs.mkdir(cachedDirectory, { recursive: true });
    await fs.writeFile(path.join(cachedDirectory, "document.json"), JSON.stringify({
      requested_url: "https://example.com/news", final_url: "https://example.com/news", title: "保存済み記事",
      text: "同一URLから直近に安全取得した十分な長さの本文を、元サイトの一時タイムアウト時だけ再利用します。別記事や古い本文は利用しません。",
      published_date: "2026-08-11", fetched_at: "2026-08-13T00:00:00.000Z", content_type: "text/html"
    }), "utf8");
    const cached = await findRecentIntakeDocument("https://example.com/news", "42", root, Date.parse("2026-08-13T01:00:00.000Z"));
    assert.equal(cached?.commentId, "41");
    assert.equal((await findRecentIntakeDocument("https://example.com/other", "42", root, Date.parse("2026-08-13T01:00:00.000Z"))), undefined, "different URLs never reuse a cached document");
    const ledger: FactLedger = { topic_key: "topic", claims: [], terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: [] };
    const article: ProcessedArticle = { raw: { title: "原題", url: "https://example.com/news", sourceName: "Example", sourceUrl: "https://example.com", category: "持ち込みニュース", reliability: "C" }, summary: {
      title_ja: "見出し", badge: "NEWS", lead: "要約です。", what_happened: "出来事です。", why_it_matters: "重要です。", reaction_view: "", editor_comment: "", japan_context_note: "", category: "その他", confidence: "C", source_type: "media_report", published_date: "", event_date: "", freshness_label: "unknown", newsworthiness_score: 0, japan_visibility: "unknown", japan_gap: "unknown", context_value: "low", sns_heat: "none", source_count: 1, source_list: [{ name: "Example", url: "https://example.com/news" }], has_official_source: false, has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "", topic_key: "topic", main_entities: { people: [], works: [], organizations: [] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "", claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }
    } };
    assert.match(buildManualReviewIssue({ commentId: "42", intakeUrl: "https://example.com/news", note: "速報", article, ledger }), /採用/);

    const richLedger: FactLedger = {
      topic_key: "映画市場",
      claims: [
        claim("C1", "夏の興行収入は85.24億元だった。", ["85.24億元"]),
        claim("C2", "平均票価は36.3元だった。", ["36.3元"]),
        claim("C3", "12億元の観賞補助金が投入された。", ["12億元"]),
        claim("C4", "北京は2000万元を補助した。", ["2000万元"]),
        claim("C5", "映画館は363館増えた。", ["363館"]),
        claim("C6", "スクリーンは2215面増えた。", ["2215面"]),
        claim("C7", "映画館に飲食やVR体験が入った。"),
        claim("C8", "映画館が交流・余暇空間へ転換している。"),
        claim("C9", "映画産業チェーンの生産額は3800億元を超えた。", ["3800億元"]),
        claim("C10", "興行収入1元が関連産業15.77元を生むとのデータが示された。", ["1元", "15.77元"]),
        claim("C11", "映画館の集客が飲食店の売上に波及した。"),
        claim("C12", "映画作品が旅行やIP商品へ展開された。")
      ],
      terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: []
    };
    const thin = { ...article.summary!, claim_refs: { ...article.summary!.claim_refs, what_happened: ["C1", "C2"] }, detail_sections: [] };
    assert.equal(assessArticleDepth(thin, richLedger, "manual_evidence_rich").passed, false, "根拠12件を2件だけに圧縮した下書きを止める");
    const oneClaimLedger: FactLedger = {
      topic_key: "2026年暑期档电影票房",
      claims: [claim("C1", "2026年暑期档の映画興行収入が92億元を超えた。", ["92亿元"])],
      terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: []
    };
    const oneClaimSummary = {
      ...article.summary!,
      lead: "2026年暑期档の映画興行収入が92億元を超えました。",
      what_happened: "2026年暑期档の映画興行収入が92億元を超えました。",
      claim_refs: { ...article.summary!.claim_refs, what_happened: ["C1"], why_it_matters: ["C1"] }
    };
    const oneClaimDepth = assessArticleDepth(oneClaimSummary, oneClaimLedger, "manual_evidence_rich");
    assert.equal(oneClaimDepth.used_claims, 1, "中国語の92亿元と表示変換後の92億元を同じ数値として扱う");
    assert.equal(oneClaimDepth.passed, false, "1/1=100%でも、台帳そのものが薄い記事は公開候補にしない");
    assert.ok(oneClaimDepth.reasons.includes("insufficient_eligible_claims:1<3"));
    const commentOnlyDepth = assessArticleDepth({
      ...oneClaimSummary,
      what_happened: "根拠を反映していない本文です。",
      claim_refs: { ...oneClaimSummary.claim_refs, what_happened: [], why_it_matters: ["C1"] }
    }, oneClaimLedger, "manual_evidence_rich");
    assert.equal(commentOnlyDepth.used_claims, 0, "コメント欄のclaim refで本文の厚みを水増ししない");
    const simplifiedEntityLedger: FactLedger = {
      ...oneClaimLedger,
      claims: [{ ...oneClaimLedger.claims[0]!, text: "赵丽颖が新作について語った。", entities: ["赵丽颖"], numbers: [] }]
    };
    const japaneseDisplayEntityDepth = assessArticleDepth({
      ...oneClaimSummary,
      what_happened: "趙麗穎が新作について語りました。",
      claim_refs: { ...oneClaimSummary.claim_refs, what_happened: ["C1"] }
    }, simplifiedEntityLedger, "manual_evidence_rich");
    assert.equal(japaneseDisplayEntityDepth.used_claims, 1, "簡体字の台帳entityと日本向け表示字形を同じ固有名として扱う");
    const rich = {
      ...thin,
      what_happened: `${richLedger.claims.map((item) => item.text).join("")}市場規模、観客負担、政策支援、施設の変化、周辺産業への波及を、確認できた数字と事実に沿って一続きの本文で整理した。`,
      claim_refs: { ...thin.claim_refs, what_happened: richLedger.claims.map((item) => item.id) },
      detail_sections: [{ heading: "本来ない段落", body: "この段落は公開形式の統一処理で削除されます。", claim_refs: ["C1"] }]
    };
    const standardRich = enforceStandardArticleFormat(rich, "manual_evidence_rich");
    assert.deepEqual(standardRich.detail_sections, [], "持ち込みでも通常記事と同じ段落構成にする");
    const depth = assessArticleDepth(standardRich, richLedger, "manual_evidence_rich");
    assert.equal(depth.passed, true, depth.reasons.join(", "));
    assert.equal(depth.used_claims, 12);
    assert.equal(depth.used_number_claims, 8);
    const boxOfficeTopic = {
      topic_type: "box_office", context_value: "high",
      topic_key: "2026年暑期档映画興行", title_hint: "2026暑期档电影票房超92亿元", event_sentence: "92億元を超えた", search_queries: []
    } as unknown as import("./types.js").TopicCandidate;
    const adequateLedger = {
      ...richLedger,
      claims: richLedger.claims.map((item, index) => ({
        ...item,
        editorial_role: index < 4 ? "key_numbers" as const : index < 8 ? "policy_support" as const : "industry_spillover" as const
      }))
    };
    assert.equal(assessLedgerAdequacy(oneClaimLedger, boxOfficeTopic).passed, false, "興行データ記事は1 claimでは生成へ進めない");
    assert.equal(assessLedgerAdequacy(adequateLedger, boxOfficeTopic).passed, true, "6件以上かつ複数の編集役割を持つ台帳は通す");
    const twentyClaimLedger = { ...adequateLedger, claims: [...adequateLedger.claims, ...adequateLedger.claims.slice(0, 8).map((item, index) => ({ ...item, id: `X${index + 1}` }))] };
    const twentyClaimRequirements = getArticleDepthRequirements(twentyClaimLedger, "manual_evidence_rich");
    assert.equal(twentyClaimRequirements.minimum_used_claims, 12, "20 root claimsなら本文に最低12件を要求する");
    assert.equal(twentyClaimRequirements.minimum_number_claims, 9, "数字claimも60%を同じ計算からpromptとgateへ渡す");
    const hallucinated = {
      ...standardRich,
      what_happened: `『台帳にない作品名』について報じられました。${standardRich.what_happened}`,
      claim_refs: { ...standardRich.claim_refs, what_happened: richLedger.claims.map((item) => item.id) }
    };
    const grounded = repairManualFactSectionGrounding(hallucinated, richLedger, "manual_evidence_rich");
    assert.equal(grounded.what_happened.includes("台帳にない作品名"), false, "根拠のない一文だけを落として確認済み本文を残す");
    assert.ok(grounded.what_happened.includes("85.24億元"), "確認済みの本文は維持する");
    const unsupportedJapanNote = repairManualFactSectionGrounding({ ...standardRich, japan_context_note: "日本では公開済みです。", claim_refs: { ...standardRich.claim_refs, japan_context_note: ["C1"] } }, richLedger, "manual_evidence_rich");
    assert.equal(unsupportedJapanNote.japan_context_note, "", "日本関連claimがなければ補足欄を公開しない");

    const personLedger: FactLedger = {
      topic_key: "李雪健",
      claims: [
        { ...claim("P1", "李雪健は26年間治療を続けている。", ["26年"]), entities: ["李雪健"], editorial_role: "personal_condition" },
        { ...claim("P2", "李雪健は両耳の聴力を失った。"), editorial_role: "personal_condition" },
        { ...claim("P3", "李雪健は声帯にも損傷がある。"), editorial_role: "personal_condition" },
        { ...claim("P4", "口の動きを見てセリフを覚える。"), editorial_role: "working_method" },
        { ...claim("P5", "相手役の動きを見て反応する。"), editorial_role: "working_method" },
        { ...claim("P6", "撮影時は手首の信号でタイミングを伝えた。"), editorial_role: "production_support" },
        { ...claim("P7", "日常会話では音声書き起こしアプリを使う。"), editorial_role: "daily_support" },
        { ...claim("P8", "俳優生活49年目を迎えた。", ["49年"]), editorial_role: "key_numbers" }
      ],
      terms: [], japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] }, unresolved: []
    };
    const issue34Thin = { ...thin, claim_refs: { ...thin.claim_refs, what_happened: ["P1", "P2", "P3", "P4"] }, detail_sections: [] };
    assert.equal(assessArticleDepth(issue34Thin, personLedger, "manual_evidence_rich").passed, false, "Issue #34型の反復中心の下書きを止める");
    const issue34Rich = {
      ...issue34Thin,
      what_happened: `${personLedger.claims.map((item) => item.text).join("")}現在の状態、本人の工夫、制作現場の支援、日常で使う補助手段を、確認できた事実に沿って一続きの本文で整理した。治療期間や俳優としての歩みの数字も落とさず、本人だけの努力として単純化しない構成にした。`,
      claim_refs: { ...issue34Thin.claim_refs, what_happened: personLedger.claims.map((item) => item.id) },
      detail_sections: []
    };
    const issue34Depth = assessArticleDepth(issue34Rich, personLedger, "manual_evidence_rich");
    assert.equal(issue34Depth.passed, true, issue34Depth.reasons.join(", "));
    assert.equal(issue34Depth.used_claims, 8);
    const named = ensureCanonicalPersonName({ ...issue34Rich, title_ja: "闘病後も続く俳優人生" }, {
      topic_key: "李雪健",
      title_hint: "李雪健のインタビュー",
      event_sentence: "李雪健が俳優を続けている",
      search_queries: [],
      seed_source: "regex_fallback",
      seed_confidence: 1,
      topic_type: "unknown",
      freshness_label: "recent",
      published_date_range: { earliest: "", latest: "" },
      source_count: 1,
      source_mix: { official: 0, media_report: 1, sns: 0, data: 0, pr_like: 0, rumor: 0, mixed: 0 },
      evidence_articles: [],
      main_entities: { people: ["李雪健", "郭帆"], works: [], organizations: [], events: [] },
      signals: { has_official_source: false, has_media_context: true, has_data_signal: false, has_hot_search_signal: false, has_multiple_sources: false },
      newsworthiness_score: 80,
      japan_gap: "unknown",
      context_value: "high",
      publish_priority: "high",
      selection_reason: "test",
      caution_note: ""
    }, personLedger);
    assert.equal(named.title_ja, "李雪健：闘病後も続く俳優人生", "再生成後も中心人物名をタイトルへ確実に残す");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("manual intake tests passed");
}

function claim(id: string, text: string, numbers: string[] = []) {
  return { id, type: "verified_fact" as const, scope: "root_event" as const, text, evidence_refs: ["E1"], entities: [], numbers, quote_zh: text.slice(0, 20), anchor: true };
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
