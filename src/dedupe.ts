import type { RawArticle } from "./types.js";

export type DedupeDropReason = "canonical_url_duplicate" | "title_similarity" | "empty_content";

export type DedupeDroppedArticle = {
  article: RawArticle;
  reason: DedupeDropReason;
  duplicateOf?: RawArticle;
};

export function dedupeArticles(articles: RawArticle[]) {
  return dedupeArticlesWithDiagnostics(articles).articles;
}

export function dedupeArticlesWithDiagnostics(articles: RawArticle[]) {
  const byUrl = new Map<string, RawArticle>();
  const unique: RawArticle[] = [];
  const dropped: DedupeDroppedArticle[] = [];

  for (const article of articles) {
    if (!article.title?.trim() || !article.url?.trim()) {
      dropped.push({ article, reason: "empty_content" });
      continue;
    }

    const normalizedUrl = normalizeUrl(article.url);
    const sameUrlArticle = byUrl.get(normalizedUrl);
    if (sameUrlArticle) {
      dropped.push({ article, reason: "canonical_url_duplicate", duplicateOf: sameUrlArticle });
      continue;
    }

    const similarTitleArticle = unique.find((existing) => areTitlesSimilar(existing.title, article.title));
    if (similarTitleArticle) {
      dropped.push({ article, reason: "title_similarity", duplicateOf: similarTitleArticle });
      continue;
    }

    byUrl.set(normalizedUrl, article);
    unique.push(article);
  }

  return { articles: unique, dropped };
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
