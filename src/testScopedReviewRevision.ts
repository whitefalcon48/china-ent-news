import assert from "node:assert/strict";
import {
  applyValidatedReviewPatch,
  buildLimitedReviewPatchPrompt,
  detectReviewRevisionIntent,
  ReviewRevisionClarificationRequiredError,
  ReviewRevisionContractError
} from "./review/revisionPatch.js";
import type { FactLedger, ReviewPatchDocument, SummarizedArticle, TopicCandidate } from "./types.js";

const ownerInstruction = "2025年12月を2025年6月17日に訂正（上海・范思哲イベント、単価約5600元のネックレス27本を約15万元で購入）。「6万元以上」は「数万元相当」に、「7人のメイクアップアーティスト」は「複数のメイク担当者」に、「純金のスマホスタンド」は「黄金／金製のスマホスタンド」に修正。「中国のエンタメ業界では『逆応援』という文化があります」は「中国のファンダムでは、芸能人側がファンへプレゼントやサービスを返す行為を『逆応援（逆应援）』と呼ぶことがあります」に修正。「娘家人」は「花嫁側の身内・実家側の人々」と補足。確度Bは維持。";

const before: SummarizedArticle = {
  title_ja: "丁禹兮、ファンに黄金のネックレスを「嫁入り道具」として贈り話題に",
  badge: "NEWS",
  lead: "中国の俳優・丁禹兮さんが、自身のコンサートでプロポーズされたファンに、自費で購入した黄金のネックレスを「娘家人からの嫁入り道具」として贈り、話題になっています。",
  what_happened: "2026年8月17日、丁禹兮さんは上海の老鳳祥のイベント会場で、自費で黄金のネックレスを購入し、以前自身のコンサートで彼氏からプロポーズされたファンに贈ると述べました。彼はこのネックレスを「娘家人からの嫁入り道具」と表現し、スタジオに連絡してそのファンに送るよう手配しました。また、その場でファンのID「KING9金金」を正確に読み上げました。\n\n丁禹兮さんはこれまでもファンへの贈り物を積極的に行っており、2026年1月25日には上海のイベントでカードを使い、ネックレス1本とブレスレット3本（総額6万元以上）を購入し、4人のファンに贈りました。2025年12月には15万元をかけて単価5600元のネックレス27本を購入し、その場にいたファンに配りました。さらに、ミルクティーや花を贈ったり、7人のメイクアップアーティストを現場に呼んでファンのメイクを行ったり、純金のスマホスタンドを贈るなどのエピソードもあります。",
  reaction_view: "",
  why_it_matters: "「娘家人」という言葉、中国の結婚文化では花嫁の実家の家族を指すんです。丁禹兮さんがファンを家族のように扱って、黄金のネックレスを「嫁入り道具」として贈ったのがすごく心に残りました！次は、このネックレスが実際にファンの手に渡ったかどうか、そしてファンがどんな反応をするのかを確認したいです。",
  editor_comment: "",
  japan_context_note: "日本ではあまり知られていないかもしれませんが、中国のエンタメ業界では「逆応援」という文化があります。丁禹兮さんの今回の行為はその典型例で、ファンを「娘家人」（実家の家族）と表現し、結婚を祝う「嫁入り道具」を贈るという、中国の結婚文化を反映した粋な計らいなんです。日本ではなかなか見られない光景なので、中国エンタメの面白さが伝わると嬉しいです。",
  category: "エンタメ",
  confidence: "B",
  source_type: "media_report",
  published_date: "2026-08-18",
  event_date: "2026-08-17",
  freshness_label: "today",
  newsworthiness_score: 80,
  japan_visibility: "low",
  japan_gap: "high",
  context_value: "high",
  sns_heat: "none",
  source_count: 2,
  source_list: [
    { name: "新浪娱乐", url: "http://k.sina.com.cn/article_7879923116_1d5ae15ac06801jxhk.html" },
    { name: "k.sina.com.cn", url: "http://k.sina.com.cn/article_7879849300_1d5acf554068013o9e.html" }
  ],
  has_official_source: false,
  has_multiple_sources: true,
  has_sns_signal: false,
  article_type: "news_event",
  skip_reason: "",
  verification_status: "verified",
  topic_key: "丁禹兮黄金嫁妆",
  main_entities: { people: ["丁禹兮"], works: [], organizations: [] },
  related_sources: [{ name: "関連資料", url: "https://example.com/context" }],
  tags: ["丁禹兮", "ファン文化"],
  publish_priority: "high",
  publish_reason: "fixture",
  claim_refs: {
    what_happened: ["C0"],
    why_it_matters: ["C0"],
    reaction_view: [],
    japan_context_note: ["C0"]
  }
};

const claim = (id: string, text: string, numbers: string[] = []) => ({
  id,
  type: "verified_fact" as const,
  text,
  evidence_refs: ["E1"],
  entities: ["丁禹兮"],
  numbers,
  anchor: true,
  scope: "root_event" as const,
  editorial_role: "other" as const
});

const ledger: FactLedger = {
  topic_key: before.topic_key,
  claims: [
    claim("C0", `${before.lead} ${before.what_happened} ${before.why_it_matters} ${before.japan_context_note}`, ["2026年8月17日", "2026年1月25日", "6万元", "4人", "2025年12月", "15万元", "5600元", "27本", "7人"]),
    claim("C1", "2025年6月17日の上海・范思哲イベントで、単価約5600元のネックレス27本を約15万元で購入した。", ["2025年", "6月", "17日", "5600元", "27本", "15万元"]),
    claim("C2", "2026年1月25日の贈答額は数万元相当だった。"),
    claim("C3", "複数のメイク担当者を現場に呼んだ。"),
    claim("C4", "黄金または金製のスマホスタンドを贈った。"),
    claim("C5", "娘家人は花嫁側の身内・実家側の人々を指す。"),
    claim("C6", "中国のファンダムでは、芸能人側がファンへプレゼントやサービスを返す行為を逆応援（逆应援）と呼ぶことがある。")
  ],
  terms: [
    { term: "娘家人", gloss_ja: "花嫁側の身内・実家側の人々" },
    { term: "逆应援", gloss_ja: "芸能人側がファンへ贈り物やサービスを返す行為" }
  ],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: []
};

const topic = {
  topic_key: before.topic_key,
  main_entities: before.main_entities,
  source_mix: { media_report: 2 },
  evidence_articles: []
} as unknown as TopicCandidate;

const intent = detectReviewRevisionIntent(before, ownerInstruction, "事実");
assert.equal(intent.mode, "limited_patch");
assert.ok(intent.allowed_fields.includes("what_happened"), "日付・金額・人数の完全一致アンカーから本文を限定する");
assert.ok(intent.allowed_fields.includes("japan_context_note"), "補足の明示と引用句から用語説明を限定する");
assert.ok(!intent.allowed_fields.includes("reaction_view"), "指示されていない空の反応欄を対象にしない");

const patch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    {
      field: "what_happened",
      operation: "replace",
      before: "2025年12月には15万元をかけて単価5600元のネックレス27本を購入し、その場にいたファンに配りました。",
      after: "2025年6月17日の上海・范思哲イベントでは、単価約5600元のネックレス27本を約15万元で購入し、その場にいたファンに配りました。",
      evidence_claim_refs: ["C1"],
      reason: "過去の贈答例の日付とイベント情報を訂正"
    },
    { field: "what_happened", operation: "replace", before: "6万元以上", after: "数万元相当", evidence_claim_refs: ["C2"], reason: "金額表現を根拠の精度に合わせる" },
    { field: "what_happened", operation: "replace", before: "7人のメイクアップアーティスト", after: "複数のメイク担当者", evidence_claim_refs: ["C3"], reason: "人数表現を訂正" },
    { field: "what_happened", operation: "replace", before: "純金のスマホスタンド", after: "黄金／金製のスマホスタンド", evidence_claim_refs: ["C4"], reason: "材質の断定を避ける" },
    {
      field: "why_it_matters",
      operation: "replace",
      before: "「娘家人」という言葉、中国の結婚文化では花嫁の実家の家族",
      after: "「娘家人」という言葉、中国の結婚文化では花嫁側の身内・実家側の人々",
      evidence_claim_refs: ["C5"],
      reason: "娘家人の意味を自然な日本語で補足"
    },
    {
      field: "japan_context_note",
      operation: "replace",
      before: "中国のエンタメ業界では「逆応援」という文化があります",
      after: "中国のファンダムでは、芸能人側がファンへプレゼントやサービスを返す行為を「逆応援」と呼ぶことがあります",
      evidence_claim_refs: ["C6"],
      reason: "逆応援を業界全体の文化と断定せず説明"
    }
  ]
};

const result = applyValidatedReviewPatch(before, topic, ledger, ownerInstruction, "事実", intent, patch);
assert.match(result.summary.what_happened, /2025年6月17日の上海・范思哲イベント/u);
assert.match(result.summary.what_happened, /数万元相当/u);
assert.match(result.summary.what_happened, /複数のメイク担当者/u);
assert.match(result.summary.what_happened, /黄金／金製のスマホスタンド/u);
assert.match(result.summary.why_it_matters, /花嫁側の身内・実家側の人々/u);
assert.match(result.summary.japan_context_note, /中国のファンダムでは/u);
assert.match(result.summary.what_happened, /ネックレス1本とブレスレット3本/u, "非対象の過去事例を保持する");
assert.match(result.summary.what_happened, /ミルクティーや花/u, "周辺の過去事例を保持する");
assert.equal(result.summary.reaction_view, "", "空だったreaction_viewへ反応を追加しない");
assert.deepEqual(result.summary.source_list, before.source_list);
assert.deepEqual(result.summary.related_sources, before.related_sources);
assert.equal(result.summary.lead, before.lead);
assert.equal(result.summary.confidence, "B");
assert.ok(result.summary.claim_refs.what_happened.includes("C1"));
assert.ok(result.summary.claim_refs.what_happened.includes("C4"));
assert.equal(result.trace.preservation.untouched_fields_exact, true);
assert.equal(result.trace.preservation.reaction_view_preserved_when_untargeted, true);
assert.ok(result.trace.preservation.claim_refs_after >= result.trace.preservation.claim_refs_before);

const actionsStyleRewrite: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    {
      field: "what_happened",
      operation: "replace_field",
      before: before.what_happened,
      after: "2026年8月17日、丁禹兮さんが黄金のネックレスを贈り、微博で話題になりました。",
      evidence_claim_refs: ["C0"],
      reason: "全体再生成"
    },
    {
      field: "reaction_view",
      operation: "replace_field",
      before: "",
      after: "微博では称賛の声が相次ぎました。",
      evidence_claim_refs: ["C0"],
      reason: "反応を追加"
    }
  ]
};
assert.throws(
  () => applyValidatedReviewPatch(before, topic, ledger, ownerInstruction, "事実", intent, actionsStyleRewrite),
  ReviewRevisionContractError,
  "Issue #57型の全体書き換えと空reaction追加を拒否する"
);

const ambiguous = detectReviewRevisionIntent(before, "日付と用語を正しくしてください。", "事実");
assert.equal(ambiguous.mode, "clarification_required");
assert.throws(
  () => applyValidatedReviewPatch(before, topic, ledger, "日付と用語を正しくしてください。", "事実", ambiguous, patch),
  ReviewRevisionClarificationRequiredError,
  "曖昧な指示を完全再生成へフォールバックしない"
);

assert.equal(detectReviewRevisionIntent(before, "記事全体を書き直してください。", "構成").mode, "full_rewrite");
const prompt = buildLimitedReviewPatchPrompt(before, ledger, ownerInstruction, intent);
assert.match(prompt, /記事全文を再生成してはいけません/u);
assert.match(prompt, /field.*operation.*before.*after.*evidence_claim_refs/su);
assert.match(prompt, /元が空の reaction_view/u);
assert.doesNotMatch(prompt, /"source_list"\s*:/u, "LLMへ非対象ソース配列を編集材料として渡さない");

const manualTopic = { ...topic, evidence_articles: [{ category: "持ち込みニュース" }] } as unknown as TopicCandidate;
const manualResult = applyValidatedReviewPatch(before, manualTopic, ledger, ownerInstruction, "事実", intent, patch);
assert.deepEqual(manualResult.summary, result.summary, "通常日次と持ち込みで同じ限定パッチ契約を使う");

console.log("scoped review revision tests passed.");
