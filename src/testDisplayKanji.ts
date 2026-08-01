import { applyDisplayKanji } from "./displayKanji.js";
import type { SummarizedArticle } from "./types.js";

const summary = {
  title_ja: "张艺谋 大众电影百花奖",
  lead: "备案・定档・热搜・谐音梗・反逻辑",
  what_happened: "干渉して夢を叶え、里帰りする",
  why_it_matters: "简体字转换测试",
  reaction_view: "",
  japan_context_note: "",
  editor_comment: ""
} as SummarizedArticle;

const result = applyDisplayKanji(summary);
assertEqual(result.summary.title_ja, "張芸謀 大衆電影百花賞", "proper nouns and award names");
assertEqual(result.summary.lead, "備案・定檔・熱捜・諧音梗・反邏輯", "industry terms");
assertEqual(result.summary.what_happened, "干渉して夢を叶え、里帰りする", "Japanese prose ambiguity guard");
assertEqual(result.summary.why_it_matters, "簡体字転換測試", "general public text");
console.log("display kanji: ok");

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
