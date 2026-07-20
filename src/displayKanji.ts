import kanjiConfig from "../config/kanji-display-map.json" with { type: "json" };
import terminologyConfig from "../config/terminology.json" with { type: "json" };
import type { SummarizedArticle } from "./types.js";

const PUBLIC_FIELDS = ["title_ja", "lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note", "editor_comment"] as const;

export type DisplayResidue = { field: (typeof PUBLIC_FIELDS)[number]; chars: string[] };

export function applyDisplayKanji(summary: SummarizedArticle): { summary: SummarizedArticle; residues: DisplayResidue[] } {
  if (process.env.DISPLAY_KANJI === "false") return { summary, residues: [] };
  const next = { ...summary };
  const protectedTerms = [
    ...terminologyConfig.known_terms,
    ...terminologyConfig.first_gloss_terms.map((item) => item.term),
    ...terminologyConfig.always_explain_terms,
    ...terminologyConfig.preferred_names.map((item) => item.zh)
  ].filter(Boolean).sort((a, b) => b.length - a.length);

  for (const field of PUBLIC_FIELDS) {
    const placeholders = new Map<string, string>();
    let value = next[field];
    for (const term of protectedTerms) {
      const placeholder = `__BT_PROTECTED_${placeholders.size}__`;
      if (!value.includes(term)) continue;
      placeholders.set(placeholder, term);
      value = value.replaceAll(term, placeholder);
    }
    value = [...value].map((character) => kanjiConfig.map[character as keyof typeof kanjiConfig.map] ?? character).join("");
    for (const [placeholder, term] of placeholders) value = value.replaceAll(placeholder, term);
    next[field] = value;
  }
  return { summary: next, residues: inspectDisplayKanjiResidues(next) };
}

export function inspectDisplayKanjiResidues(summary: SummarizedArticle): DisplayResidue[] {
  if (process.env.DISPLAY_KANJI === "false") return [];
  const residueCharacters = new Set([...Object.keys(kanjiConfig.map), ...kanjiConfig.detect_only]);
  return PUBLIC_FIELDS.flatMap((field) => {
    const chars = [...new Set([...summary[field]].filter((character) => residueCharacters.has(character)))];
    return chars.length ? [{ field, chars }] : [];
  });
}
