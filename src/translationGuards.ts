import type { RawArticle, SummarizedArticle } from "./types.js";
import { toDisplayKanji } from "./displayKanji.js";

const PUBLIC_FIELDS = ["title_ja", "lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note", "editor_comment"] as const;

/** Repair only narrow translation confusions provable from the source text. */
export function applyEvidenceTranslationGuards(summary: SummarizedArticle, evidence: RawArticle[]) {
  const sourceText = evidence.map((article) => `${article.title}\n${article.rawContent || article.excerpt || ""}`).join("\n");

  // 小人物 is a common contrast to 英雄/大人物: an ordinary person, not a
  // small or medium-sized company. The guard is evidence-based so legitimate
  // 中小企业 reporting remains untouched.
  if (/小人物/u.test(sourceText) && !/中小企业|中小企業/u.test(sourceText)) {
    for (const field of PUBLIC_FIELDS) summary[field] = summary[field].replace(/中小企業/gu, "普通の人");
  }

  // When a Japanese/translated work title is followed by a title found in the
  // Chinese evidence, that parenthetical title is the original title, never a
  // Japanese title. This is shared across works rather than a one-title fix.
  const originalTitles = [...sourceText.matchAll(/《([^》\r\n]{1,80})》/gu)].map((match) => match[1].trim());
  for (const originalTitle of new Set(originalTitles)) {
    const displayTitle = toDisplayKanji(originalTitle);
    const variants = [...new Set([originalTitle, displayTitle])].map(escapeRegex).join("|");
    const mislabeled = new RegExp(`（邦題[:：]?\\s*[『「《]?(?:${variants})[』」》]?）`, "gu");
    for (const field of PUBLIC_FIELDS) {
      summary[field] = summary[field].replace(mislabeled, `（原題：『${displayTitle}』）`);
    }
  }
  return summary;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
