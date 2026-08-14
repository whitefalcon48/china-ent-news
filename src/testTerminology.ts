import assert from "node:assert/strict";
import { applyTerminology, formatTerminologyForPrompt } from "./terminology.js";
import { applyEvidenceTranslationGuards } from "./translationGuards.js";
import type { RawArticle, SummarizedArticle } from "./types.js";

function summary(overrides: Partial<SummarizedArticle>): SummarizedArticle {
  return {
    title_ja: "見出し", badge: "NEWS", lead: "", what_happened: "", why_it_matters: "", reaction_view: "", editor_comment: "", japan_context_note: "",
    category: "映画", confidence: "B", source_type: "media_report", published_date: "", event_date: "", freshness_label: "recent", newsworthiness_score: 0,
    japan_visibility: "unknown", japan_gap: "unknown", context_value: "medium", sns_heat: "none", source_count: 1, source_list: [], has_official_source: false,
    has_multiple_sources: false, has_sns_signal: false, article_type: "news_event", skip_reason: "", verification_status: "", topic_key: "test",
    main_entities: { people: [], works: [], organizations: [] }, related_sources: [], tags: [], publish_priority: "medium", publish_reason: "",
    claim_refs: { what_happened: [], why_it_matters: [], reaction_view: [], japan_context_note: [] }, detail_sections: [], ...overrides
  };
}

const title = await applyTerminology(summary({ japan_context_note: "文牧野監督は『薬の神じゃない』（邦題『我不是薬神』）で知られます。" }));
assert.equal(title.japan_context_note, "文牧野監督は『薬の神じゃない！』（原題：『我不是薬神』）で知られます。");
assert.match(await formatTerminologyForPrompt(), /小人物（英雄や大人物ではない平凡な人物・普通の人）/u);

const evidence = [{ title: "作品紹介", url: "https://example.com", sourceName: "example", category: "映画", reliability: "B", rawContent: "现实题材聚焦小人物的选择。电影《星河》已经上映。" }] as RawArticle[];
const guarded = applyEvidenceTranslationGuards(summary({ what_happened: "戦争下の中小企業を描いた作品です。" }), evidence);
assert.equal(guarded.what_happened, "戦争下の普通の人を描いた作品です。");

const annotation = applyEvidenceTranslationGuards(summary({ japan_context_note: "日本題『銀河』（邦題：『星河』）も知られています。" }), evidence);
assert.equal(annotation.japan_context_note, "日本題『銀河』（原題：『星河』）も知られています。");

const businessEvidence = [{ ...evidence[0], rawContent: "战争下的中小企业经营情况" }] as RawArticle[];
const legitimate = applyEvidenceTranslationGuards(summary({ what_happened: "戦争下の中小企業を描いた作品です。" }), businessEvidence);
assert.equal(legitimate.what_happened, "戦争下の中小企業を描いた作品です。");

console.log("terminology and translation guards: ok");
