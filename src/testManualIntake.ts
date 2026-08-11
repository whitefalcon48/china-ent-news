import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buildManualReviewIssue } from "./intake/buildManualReviewIssue.js";
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("manual intake tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
