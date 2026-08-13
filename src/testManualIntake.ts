import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buildManualReviewIssue } from "./intake/buildManualReviewIssue.js";
import { assessArticleDepth } from "./articleDepth.js";
import { fetchIntakeDocument, isPrivateAddress } from "./intake/fetchIntakeDocument.js";
import { updateManualIntakeState, writeManualIntakeState } from "./intake/intakeState.js";
import { parseManualIntake } from "./intake/parseManualIntake.js";
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
  const unsafe = await fetchIntakeDocument("http://127.0.0.1/news", { lookupHost: async () => ["127.0.0.1"] });
  assert.deepEqual(unsafe, { ok: false, error: "unsafe_url" });
  const fetched = await fetchIntakeDocument("https://news.example/article", {
    lookupHost: async () => ["8.8.8.8"],
    fetchImpl: async () => new Response("<html><title>記事</title><article>これは持ち込みニュース用に十分な長さを持つ本文です。確認できた事実だけを使います。</article></html>", { headers: { "content-type": "text/html" } })
  });
  assert.equal(fetched.ok, true);
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
    const rich = {
      ...thin,
      detail_sections: [
        { heading: "重要数字", body: "夏の興行収入は85.24億元、平均票価は36.3元でした。市場規模が伸びる一方で観客の負担は下がったという、二つの変化を同時に確認できます。", claim_refs: ["C1", "C2"] },
        { heading: "補助金", body: "全国で12億元の観賞補助金が投入され、北京だけでも2000万元が用意されました。値下がりを市場任せにせず、政策面から支えている点が分かります。", claim_refs: ["C3", "C4"] },
        { heading: "映画館の変化", body: "映画館は363館、スクリーンは2215面増えました。飲食やVR体験も入り、上映だけを提供する場所から、交流や余暇を過ごす空間へ役割が広がっています。", claim_refs: ["C5", "C6", "C7", "C8"] },
        { heading: "産業への波及", body: "産業チェーンは3800億元を超え、興行収入1元が関連産業15.77元を生むとのデータも示されました。飲食店の売上、旅行、IP商品まで、映画館の外へ消費が波及しています。", claim_refs: ["C9", "C10", "C11", "C12"] }
      ]
    };
    const depth = assessArticleDepth(rich, richLedger, "manual_evidence_rich");
    assert.equal(depth.passed, true, depth.reasons.join(", "));
    assert.equal(depth.used_claims, 12);
    assert.equal(depth.used_number_claims, 8);

    const personLedger: FactLedger = {
      topic_key: "李雪健",
      claims: [
        { ...claim("P1", "李雪健は26年間治療を続けている。", ["26年"]), editorial_role: "personal_condition" },
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
      detail_sections: [
        { heading: "治療後の状態", body: "26年間の治療を経て、両耳の聴力を失い、声帯にも損傷が残っています。現在の活動を理解する前提として、治療後に残った二つの状態を整理します。", claim_refs: ["P1", "P2", "P3"] },
        { heading: "演技を続ける方法", body: "口の動きからセリフを捉え、相手役の動きを見て反応しています。音に頼れない場面で本人が実際に使っている二つの方法を具体的に示します。", claim_refs: ["P4", "P5"] },
        { heading: "撮影側の支援", body: "撮影時には手首へ信号を送り、セリフのタイミングを伝える仕組みが使われました。本人の努力だけにまとめず、制作現場が用意した支援として分けて伝えます。", claim_refs: ["P6"] },
        { heading: "日常の補助手段と歩み", body: "日常会話では音声書き起こしアプリを使っています。俳優生活49年目という数字も示し、撮影現場以外の補助手段と現在までの歩みを一緒に確認します。", claim_refs: ["P7", "P8"] }
      ]
    };
    const issue34Depth = assessArticleDepth(issue34Rich, personLedger, "manual_evidence_rich");
    assert.equal(issue34Depth.passed, true, issue34Depth.reasons.join(", "));
    assert.equal(issue34Depth.used_claims, 8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("manual intake tests passed");
}

function claim(id: string, text: string, numbers: string[] = []) {
  return { id, type: "verified_fact" as const, scope: "root_event" as const, text, evidence_refs: ["E1"], entities: [], numbers, quote_zh: text.slice(0, 20), anchor: true };
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
