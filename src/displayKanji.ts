import kanjiConfig from "../config/kanji-display-map.json" with { type: "json" };
import OpenCC from "opencc-js";
import type { SummarizedArticle } from "./types.js";

const PUBLIC_FIELDS = ["title_ja", "lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note", "editor_comment"] as const;

export type DisplayResidue = { field: string; chars: string[] };

const toJapaneseShinjitai = OpenCC.Converter({ from: "cn", to: "jp" });
const openCcSafeInputs = new Set<string>(kanjiConfig.opencc_safe);

export function convertDisplayText(value: string) {
  // Project-specific choices (for example 奖 -> 賞) take precedence over the
  // general OpenCC cn -> jp conversion. No proper noun or industry term is
  // exempt: every public field follows the same display rule.
  const protectedTags: string[] = [];
  const protectedValue = value.replace(/#[^#\r\n]+#/gu, (tag) => {
    const token = `\u0000HOTSEARCH${protectedTags.length}\u0000`;
    protectedTags.push(tag);
    return token;
  });
  const mapped = [...protectedValue]
    .map((character) => {
      const projectMapping = kanjiConfig.map[character as keyof typeof kanjiConfig.map];
      if (projectMapping) return projectMapping;
      // Some Han characters are valid Japanese characters with a different
      // meaning (for example 干・叶・里). Converting all Japanese prose as
      // Chinese would corrupt it, so OpenCC is applied only to reviewed,
      // unambiguous simplified inputs. Ambiguous inputs stay in detect_only.
      return openCcSafeInputs.has(character) ? toJapaneseShinjitai(character) : character;
    })
    .join("");
  return mapped.replace(/\u0000HOTSEARCH(\d+)\u0000/gu, (_, index: string) => protectedTags[Number(index)] ?? "");
}

export function toDisplayKanji(value: string) {
  return process.env.DISPLAY_KANJI === "false" ? value : convertDisplayText(value);
}

export function applyDisplayKanji(summary: SummarizedArticle): { summary: SummarizedArticle; residues: DisplayResidue[] } {
  if (process.env.DISPLAY_KANJI === "false") return { summary, residues: [] };
  const next = { ...summary };
  for (const field of PUBLIC_FIELDS) {
    next[field] = convertDisplayText(next[field]);
  }
  next.detail_sections = summary.detail_sections?.map((section) => ({
    ...section,
    heading: convertDisplayText(section.heading),
    body: convertDisplayText(section.body)
  }));
  return { summary: next, residues: inspectDisplayKanjiResidues(next) };
}

export function inspectDisplayKanjiResidues(summary: SummarizedArticle): DisplayResidue[] {
  if (process.env.DISPLAY_KANJI === "false") return [];
  const residueCharacters = new Set([...Object.keys(kanjiConfig.map), ...kanjiConfig.opencc_safe, ...kanjiConfig.detect_only]);
  const fields = PUBLIC_FIELDS.flatMap((field) => {
    const chars = [...new Set([...summary[field]].filter((character) => residueCharacters.has(character)))];
    return chars.length ? [{ field, chars }] : [];
  });
  const detailResidues = (summary.detail_sections ?? []).flatMap((section, index) => {
    const chars = [...new Set([...`${section.heading}${section.body}`].filter((character) => residueCharacters.has(character)))];
    return chars.length ? [{ field: `detail_sections.${index}`, chars }] : [];
  });
  return [...fields, ...detailResidues];
}
