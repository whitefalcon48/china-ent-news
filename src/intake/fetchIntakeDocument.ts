import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { extractDocumentSnapshot } from "../evidence/documentSnapshot.js";

const MAX_REDIRECTS = 3;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "user-agent": "Mozilla/5.0 (compatible; ChinaEntNewsManualIntake/1.0)"
};

type PinnedRequest = (options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;
type SafeUrl = { address: string; family: 4 | 6 };

export type IntakeDocument = {
  requested_url: string;
  final_url: string;
  title: string;
  text: string;
  published_date: string;
  fetched_at: string;
  content_type: string;
};

export type IntakeFetchResult = { ok: true; document: IntakeDocument } | { ok: false; error: string };

export type IntakeFetchOptions = {
  /** Test-only compatibility hook. Production uses a pinned node:http(s) request. */
  fetchImpl?: typeof fetch;
  /** Test-only request hook for asserting the production pinned-connection path. */
  requestImpl?: PinnedRequest;
  lookupHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
};

/** Keeps a stable provenance URL while avoiding persistence of signed/query URLs. */
export function redactIntakeUrl(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Fetches a user-provided URL without allowing it to become an internal-network
 * proxy. Production requests are pinned to a DNS address that has just passed
 * the public-address policy, so the HTTP client cannot re-resolve a rebinding
 * hostname between validation and connection.
 */
export async function fetchIntakeDocument(value: string, options: IntakeFetchOptions = {}): Promise<IntakeFetchResult> {
  const lookupHost = options.lookupHost ?? resolveHostAddresses;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current: URL;
  try {
    current = new URL(value);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const safe = await validateSafeExternalUrl(current, lookupHost);
    if (!safe.ok) return safe;
    try {
      const response = options.fetchImpl
        ? await fetchWithCompatibilityHook(current, options.fetchImpl, timeoutMs)
        : await requestPinnedDocument(current, safe.address, timeoutMs, options.requestImpl);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.location;
        if (!location) return { ok: false, error: "redirect_without_location" };
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) return { ok: false, error: `http_${response.status}` };
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.contentType)) {
        return { ok: false, error: "unsupported_content_type" };
      }
      if (response.contentLength > MAX_DOCUMENT_BYTES) return { ok: false, error: "document_too_large" };
      const html = await response.readText(MAX_DOCUMENT_BYTES);
      const snapshot = extractDocumentSnapshot(html);
      if (!snapshot.text || snapshot.text.length < 40) return { ok: false, error: "document_text_too_short" };
      return {
        ok: true,
        document: {
          requested_url: redactIntakeUrl(value),
          final_url: redactIntakeUrl(current.toString()),
          title: snapshot.title,
          text: snapshot.text,
          published_date: snapshot.published_date,
          fetched_at: new Date().toISOString(),
          content_type: response.contentType
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof IntakeFetchTimeoutError ? "fetch_timeout" : error instanceof Error && error.message === "document_too_large" ? "document_too_large" : "fetch_failed" };
    }
  }
  return { ok: false, error: "too_many_redirects" };
}

type DocumentResponse = {
  status: number;
  location: string;
  contentType: string;
  contentLength: number;
  readText: (maxBytes: number) => Promise<string>;
};

async function fetchWithCompatibilityHook(url: URL, fetchImpl: typeof fetch, timeoutMs: number): Promise<DocumentResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal, headers: REQUEST_HEADERS });
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      contentType: response.headers.get("content-type") ?? "",
      contentLength: Number(response.headers.get("content-length") ?? "0"),
      readText: (maxBytes) => readBoundedWebText(response, maxBytes)
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new IntakeFetchTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestPinnedDocument(url: URL, pinned: SafeUrl, timeoutMs: number, override?: PinnedRequest): Promise<DocumentResponse> {
  const requestImpl = override ?? (url.protocol === "https:" ? https.request : http.request) as unknown as PinnedRequest;
  const port = url.protocol === "https:" ? 443 : 80;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...REQUEST_HEADERS, host: url.hostname },
      // Preserve virtual-host routing and TLS certificate selection while the
      // custom lookup makes the socket connect to the inspected address.
      servername: url.hostname,
      family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family)
    }, resolve);
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new IntakeFetchTimeoutError()));
    request.end();
  });
  const contentLength = Number(response.headers["content-length"] ?? "0");
  return {
    status: response.statusCode ?? 0,
    location: headerValue(response.headers.location),
    contentType: headerValue(response.headers["content-type"]),
    contentLength,
    readText: (maxBytes) => readBoundedNodeText(response, maxBytes)
  };
}

async function validateSafeExternalUrl(url: URL, lookupHost: (hostname: string) => Promise<string[]>): Promise<{ ok: true; address: SafeUrl } | { ok: false; error: string }> {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname || url.port) return { ok: false, error: "unsafe_url" };
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { ok: false, error: "unsafe_url" };
  }
  const addresses = isIpLiteral(hostname) ? [hostname] : await lookupHost(hostname).catch(() => []);
  if (!addresses.length || addresses.some(isPrivateAddress)) return { ok: false, error: "unsafe_url" };
  const address = addresses[0];
  const family = address.includes(":") ? 6 : 4;
  return { ok: true, address: { address, family } };
}

async function resolveHostAddresses(hostname: string) {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function isIpLiteral(value: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) || value.includes(":");
}

/** Rejects private, special-use, documentation, benchmark, multicast, and reserved ranges. */
export function isPrivateAddress(value: string) {
  const address = value.replace(/^\[|\]$/gu, "").toLowerCase();
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPrivateIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  if (!ipv6) return true;
  const mappedIpv4 = ipv6MappedIpv4(ipv6);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  return isPrivateIpv6(ipv6);
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isPrivateIpv4(parts: number[]) {
  const [first, second, third] = parts;
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 88 && third === 99 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) ||
    (first === 203 && second === 0 && third === 113);
}

function parseIpv6(value: string): number[] | null {
  const normalized = value.split("%")[0];
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const expand = (half: string) => half ? half.split(":") : [];
  const left = expand(halves[0]);
  const right = halves.length === 2 ? expand(halves[1]) : [];
  const convert = (parts: string[]): number[] | null => {
    const values: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        values.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/u.test(part)) {
        values.push(Number.parseInt(part, 16));
      } else return null;
    }
    return values;
  };
  const leftValues = convert(left);
  const rightValues = convert(right);
  if (!leftValues || !rightValues) return null;
  if (halves.length === 1) return leftValues.length === 8 ? leftValues : null;
  const missing = 8 - leftValues.length - rightValues.length;
  return missing >= 1 ? [...leftValues, ...Array(missing).fill(0), ...rightValues] : null;
}

function ipv6MappedIpv4(parts: number[]) {
  const firstSixZero = parts.slice(0, 6).every((part) => part === 0);
  const compatible = firstSixZero;
  const mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (!compatible && !mapped) return null;
  return [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff];
}

function isPrivateIpv6(parts: number[]) {
  return parts.every((part) => part === 0) ||
    parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1 ||
    (parts[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (parts[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (parts[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
    (parts[0] === 0x2001 && parts[1] === 0x0db8); // 2001:db8::/32 documentation
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function readBoundedWebText(response: Response, maxBytes: number) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("document_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return decodeChunks(chunks, received);
}

async function readBoundedNodeText(response: http.IncomingMessage, maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    received += bytes.byteLength;
    if (received > maxBytes) {
      response.destroy();
      throw new Error("document_too_large");
    }
    chunks.push(bytes);
  }
  return decodeChunks(chunks, received);
}

function decodeChunks(chunks: Uint8Array[], received: number) {
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

class IntakeFetchTimeoutError extends Error {}
