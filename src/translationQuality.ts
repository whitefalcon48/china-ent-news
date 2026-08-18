import type { SummarizedArticle } from "./types.js";

export type LiteralTranslationResidue = { field: string; term: string; guidance: string };

const RULES = [
  { term: "反套路", guidance: "ジャンルのどの定番をどう逆手に取るのか、作品内容で説明する" },
  { term: "軽喜劇", guidance: "作品内容に合わせて、軽やかな／気軽に楽しめるコメディなど自然な日本語にする" },
  { term: "現象級", guidance: "宣伝評価を事実化せず、確認できる読者数・評価・展開実績か、情報源への帰属で示す" },
  { term: "脆いサラリーマン", guidance: "体調や働く人の感覚を、根拠にある具体的な内容へほどく" },
  { term: "病危", guidance: "命に関わる状態、重篤な状態など文脈に合う日本語で説明する" },
  { term: "打工人", guidance: "会社員／働く人のどの感覚を指すのか、物語との組み合わせが分かるようにする" },
  { term: "開幕前の最高密度の宣伝", guidance: "宣伝記事の直訳を避け、確認できた告知内容と日付だけを書く" }
] as const;

const PUBLIC_FIELDS = ["title_ja", "lead", "what_happened", "why_it_matters", "reaction_view", "japan_context_note"] as const;

export function inspectLiteralTranslationResidues(summary: SummarizedArticle): LiteralTranslationResidue[] {
  const residues: LiteralTranslationResidue[] = [];
  for (const field of PUBLIC_FIELDS) {
    const text = summary[field] || "";
    for (const rule of RULES) if (text.includes(rule.term)) residues.push({ field, ...rule });
  }
  for (const [index, section] of (summary.detail_sections ?? []).entries()) {
    for (const rule of RULES) if (`${section.heading}\n${section.body}`.includes(rule.term)) residues.push({ field: `detail_sections.${index}`, ...rule });
  }
  return residues;
}

export function inspectLiteralTranslationText(text: string, field = "text"): LiteralTranslationResidue[] {
  return RULES.filter((rule) => text.includes(rule.term)).map((rule) => ({ field, ...rule }));
}

export function formatTranslationQualityForPrompt() {
  return RULES.map((rule) => `- 「${rule.term}」をそのまま日本語本文へ残さない: ${rule.guidance}`).join("\n");
}
