import fs from "node:fs/promises";
import path from "node:path";
import { applyDisplayKanji } from "./displayKanji.js";
import type { SummarizedArticle } from "./types.js";

export type TerminologyConfig = {
  version: number;
  preferred_names: Array<{ zh: string; display: string; first_mention: string; avoid: string[] }>;
  known_terms: string[];
  first_gloss_terms: Array<{ term: string; gloss: string }>;
  always_explain_terms: string[];
  person_names: Array<{ zh: string; display: string; reading: string }>;
  work_titles: Array<{ zh: string; display: string; ja_official: string; avoid?: string[] }>;
  word_overrides: Array<{ zh: string; display: string }>;
};

const EMPTY: TerminologyConfig = { version: 1, preferred_names: [], known_terms: [], first_gloss_terms: [], always_explain_terms: [], person_names: [], work_titles: [], word_overrides: [] };
let cache: TerminologyConfig | undefined;

export async function loadTerminology(): Promise<TerminologyConfig> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(path.resolve("config/terminology.json"), "utf8")) as Partial<TerminologyConfig>;
    cache = {
      version: parsed.version ?? 1,
      preferred_names: parsed.preferred_names ?? [],
      known_terms: parsed.known_terms ?? [],
      first_gloss_terms: parsed.first_gloss_terms ?? [],
      always_explain_terms: parsed.always_explain_terms ?? [],
      person_names: parsed.person_names ?? [],
      work_titles: parsed.work_titles ?? [],
      word_overrides: parsed.word_overrides ?? []
    };
  } catch (error) {
    console.warn(`terminology warning: ${error instanceof Error ? error.message : String(error)}`);
    cache = EMPTY;
  }
  return cache;
}

export async function applyTerminology(summary: SummarizedArticle): Promise<SummarizedArticle> {
  const config = await loadTerminology();
  const next = { ...summary };
  const fields = ["title_ja", "lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note", "editor_comment"] as const;
  for (const work of [...config.work_titles].sort((a, b) => b.zh.length - a.zh.length)) {
    let seen = false;
    const variants = [work.zh, work.display, work.ja_official, ...(work.avoid ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
    const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
    for (const field of fields) {
      let normalizedComposed = false;
      if (work.ja_official) {
        const titleVariants = [work.ja_official, ...(work.avoid ?? [])].filter(Boolean).map(escapeRegex).join("|");
        const originalVariants = [work.zh, work.display].map(escapeRegex).join("|");
        const composed = new RegExp(`[『「]?(?:${titleVariants})[』」]?（(?:邦題|原題)[:：]?『?(?:${originalVariants})』?）`, "g");
        next[field] = next[field].replace(composed, () => {
          seen = true;
          normalizedComposed = true;
          return `『${work.ja_official}』（原題：『${work.display}』）`;
        });
      }
      if (normalizedComposed) continue;
      next[field] = next[field].replace(regex, () => {
        if (!work.ja_official) return work.display;
        if (!seen) {
          seen = true;
          return `${work.ja_official}（原題：『${work.display}』）`;
        }
        return work.ja_official;
      });
    }
  }
  for (const person of [...config.person_names].sort((a, b) => b.zh.length - a.zh.length)) {
    let seen = false;
    const firstMention = person.reading ? `${person.display}（${person.reading}）` : person.display;
    const variants = [firstMention, person.zh, person.display].sort((a, b) => b.length - a.length);
    const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
    for (const field of fields) {
      next[field] = next[field].replace(regex, (matched) => {
        if (matched === firstMention) {
          seen = true;
          return matched;
        }
        if (!seen) {
          seen = true;
          return firstMention;
        }
        return person.display;
      });
    }
  }
  for (const override of [...config.word_overrides].sort((a, b) => b.zh.length - a.zh.length)) {
    for (const field of fields) next[field] = next[field].replaceAll(override.zh, override.display);
  }
  for (const preferred of config.preferred_names) {
    let seen = false;
    const variants = [preferred.first_mention, preferred.zh, ...preferred.avoid, preferred.display].sort((a, b) => b.length - a.length);
    const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
    for (const field of fields) {
      next[field] = next[field].replace(regex, (matched) => {
        if (matched === preferred.first_mention) {
          seen = true;
          return matched;
        }
        if (!seen) {
          seen = true;
          return preferred.first_mention;
        }
        return preferred.display;
      });
    }
  }
  next.detail_sections = summary.detail_sections?.map((section) => {
    let heading = section.heading;
    let body = section.body;
    for (const work of [...config.work_titles].sort((a, b) => b.zh.length - a.zh.length)) {
      const variants = [work.zh, work.display, work.ja_official, ...(work.avoid ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
      const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
      heading = heading.replace(regex, work.ja_official || work.display);
      body = body.replace(regex, work.ja_official || work.display);
    }
    for (const person of [...config.person_names].sort((a, b) => b.zh.length - a.zh.length)) {
      const variants = [person.zh, person.display, person.reading ? `${person.display}（${person.reading}）` : ""].filter(Boolean).sort((a, b) => b.length - a.length);
      const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
      heading = heading.replace(regex, person.display);
      body = body.replace(regex, person.display);
    }
    for (const preferred of config.preferred_names) {
      const variants = [preferred.first_mention, preferred.zh, ...preferred.avoid, preferred.display].filter(Boolean).sort((a, b) => b.length - a.length);
      const regex = new RegExp(variants.map(escapeRegex).join("|"), "g");
      heading = heading.replace(regex, preferred.display);
      body = body.replace(regex, preferred.display);
    }
    for (const override of [...config.word_overrides].sort((a, b) => b.zh.length - a.zh.length)) {
      heading = heading.replaceAll(override.zh, override.display);
      body = body.replaceAll(override.zh, override.display);
    }
    return { ...section, heading, body };
  });
  return applyDisplayKanji(next).summary;
}

export async function formatTerminologyForPrompt() {
  const config = await loadTerminology();
  return [
    `優先表記: ${config.preferred_names.map((item) => `${item.zh}・${item.avoid.join("・")} → 初出「${item.first_mention}」、以降「${item.display}」`).join(" / ") || "なし"}`,
    `既知語（説明不要）: ${config.known_terms.join(" / ") || "なし"}`,
    `初出時に補足: ${config.first_gloss_terms.map((item) => `${item.term}（${item.gloss}）`).join(" / ") || "なし"}`,
    `毎回説明する語: ${config.always_explain_terms.join(" / ") || "なし"}`
  ].join("\n");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
