const MISSING_SUMMARY_TITLES = new Set(["タイトル未設定"]);

export function resolveSummaryTitle(value: unknown, ...fallbacks: Array<string | undefined>): string {
  for (const candidate of [value, ...fallbacks]) {
    if (typeof candidate !== "string") continue;
    const title = candidate.trim();
    if (title && !MISSING_SUMMARY_TITLES.has(title)) return title;
  }

  return "";
}
