import fs from "node:fs/promises";
import path from "node:path";
import type { SummarizedArticle } from "./types.js";

export type TerminologyConfig = {
  version: number;
  preferred_names: Array<{ zh: string; display: string; first_mention: string; avoid: string[] }>;
  known_terms: string[];
  first_gloss_terms: Array<{ term: string; gloss: string }>;
  always_explain_terms: string[];
};

const EMPTY: TerminologyConfig = { version: 1, preferred_names: [], known_terms: [], first_gloss_terms: [], always_explain_terms: [] };
let cache: TerminologyConfig | undefined;

export async function loadTerminology(): Promise<TerminologyConfig> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(path.resolve("config/terminology.json"), "utf8")) as TerminologyConfig;
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
  return next;
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
