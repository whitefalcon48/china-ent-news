/**
 * Groups hosts that are commonly syndication siblings.  This is deliberately
 * conservative: an unknown host remains its own family instead of being
 * merged with an unrelated publisher.
 */
export function normalizeMediaFamily(urlOrHost: string) {
  const host = hostname(urlOrHost);
  if (!host) return "unknown";

  const rules: Array<[RegExp, string]> = [
    [/(^|\.)sina\.com\.cn$/, "sina"],
    [/(^|\.)sina\.cn$/, "sina"],
    [/(^|\.)weibo\.com$/, "sina"],
    [/(^|\.)tencent\.com$/, "tencent"],
    [/(^|\.)qq\.com$/, "tencent"],
    [/(^|\.)sohu\.com$/, "sohu"],
    [/(^|\.)163\.com$/, "netease"],
    [/(^|\.)thepaper\.cn$/, "thepaper"],
    [/(^|\.)bjnews\.com\.cn$/, "xinjingbao"],
    [/(^|\.)1905\.com$/, "1905"],
    [/(^|\.)douban\.com$/, "douban"],
    [/(^|\.)bilibili\.com$/, "bilibili"]
  ];
  return rules.find(([pattern]) => pattern.test(host))?.[1] ?? host;
}

function hostname(value: string) {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  } catch {
    return "";
  }
}
