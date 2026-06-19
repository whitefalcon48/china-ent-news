import type { RawArticle } from "./types.js";

export function dedupeArticles(articles: RawArticle[]) {
  const byUrl = new Map<string, RawArticle>();
  const unique: RawArticle[] = [];

  for (const article of articles) {
    const normalizedUrl = normalizeUrl(article.url);
    if (byUrl.has(normalizedUrl)) {
      continue;
    }

    const hasSimilarTitle = unique.some((existing) => areTitlesSimilar(existing.title, article.title));
    if (hasSimilarTitle) {
      continue;
    }

    byUrl.set(normalizedUrl, article);
    unique.push(article);
  }

  return unique;
}

function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function areTitlesSimilar(a: string, b: string) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);

  if (!left || !right) {
    return false;
  }

  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = new Set(splitTitle(left));
  const rightTokens = splitTitle(right);
  const overlap = rightTokens.filter((token) => leftTokens.has(token)).length;
  const smallerSize = Math.min(leftTokens.size, rightTokens.length);

  return smallerSize >= 4 && overlap / smallerSize >= 0.75;
}

function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]/gu, "")
    .trim();
}

function splitTitle(title: string) {
  const chars = Array.from(title);
  const tokens: string[] = [];

  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index]}${chars[index + 1]}`);
  }

  return tokens;
}
