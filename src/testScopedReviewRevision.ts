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

const issue63Before: SummarizedArticle = {
  ...before,
  title_ja: "『私の前半生』公式微博が再始動、主演たちの現在地と再ブームの理由",
  lead: "2017年の大ヒットドラマ『私の前半生』の公式微博が約9年ぶりに更新を再開し、関連コンテンツの再生数が急増。主演たちのその後の活躍も改めて注目を集めている。",
  what_happened: "2026年8月22日、ドラマ『私の前半生』の公式微博が長年の沈黙を破って更新を再開した。公式微博は二創募集、ドラマレビューコンテスト、クイズ大会、性格診断テストを開始した。関連コンテンツの再生増加量は49億回を超え、微博の累計閲覧数は32.8億に達した。プロデューサーの黄澜は、名場面がネットミーム化したことなどを再ブームの理由に挙げた。",
  reaction_view: "",
  why_it_matters: "羅子君が夫の陳俊生と離婚してすべてを失い、親友の唐晶とその彼氏の賀涵の助けで職場に入り、自己成長していく物語です！陳俊生は同僚の凌玲と不倫して羅子君と離婚し、凌玲と再婚します。この設定が、放送当時は「クズ男」と叩かれた陳俊生を、今では「中国の良い元夫」と呼ばせるほど視聴者の見方を変えたんです。",
  japan_context_note: "",
  category: "ドラマ",
  confidence: "C",
  topic_key: "我的前半生主演现状",
  main_entities: {
    people: ["雷佳音", "馬伊琍", "袁泉", "呉越", "黄澜"],
    works: ["我的前半生"],
    organizations: []
  },
  source_list: [
    { name: "新浪娱乐", url: "https://example.com/root" },
    { name: "関連媒体", url: "https://example.com/related" }
  ],
  related_sources: [{ name: "追加資料", url: "https://example.com/context" }],
  claim_refs: {
    what_happened: ["C1", "C2", "C3", "C4", "C5"],
    why_it_matters: ["C13", "C15"],
    reaction_view: [],
    japan_context_note: []
  },
  detail_sections: []
};

const issue63Claim = (
  id: string,
  text: string,
  entities: string[],
  editorialRole: "story_premise" | "other" = "other"
) => ({
  id,
  type: "verified_fact" as const,
  text,
  evidence_refs: ["E2"],
  entities,
  numbers: [],
  anchor: true,
  scope: "root_event" as const,
  editorial_role: editorialRole,
  angle_kind: "other" as const
});

const issue63Ledger: FactLedger = {
  topic_key: issue63Before.topic_key,
  claims: [
    {
      id: "C2",
      type: "unsupported",
      text: "公式微博は二創募集、ドラマレビューコンテスト、クイズ大会、性格診断テストを開始し、賞金と主演の非売品サイン写真を賞品として提供した。",
      evidence_refs: ["E1"],
      entities: ["我的前半生", "微博"],
      numbers: [],
      quote_zh: "上线二创征集、剧评大赛、答题赛和人格测试，并设置奖金与主演绝",
      anchor: true,
      scope: "root_event",
      editorial_role: "other",
      angle_kind: "other"
    },
    issue63Claim("C13", "羅子君が離婚後、唐晶と賀涵の助けで職場に入り自己成長する物語である。", ["羅子君", "陳俊生", "唐晶", "賀涵"], "story_premise"),
    issue63Claim("C15", "陳俊生は同僚の凌玲と不倫し、羅子君と離婚して凌玲と再婚する。", ["陳俊生", "凌玲", "羅子君"], "story_premise"),
    issue63Claim("C16", "陳俊生は離婚後も子どもや前妻一家の面倒を見続けた。", ["陳俊生", "羅子君"]),
    issue63Claim("C17", "陳俊生は再婚後も家庭の矛盾と新たな悩みを抱えた。", ["陳俊生"]),
    issue63Claim("C18", "陳俊生は臆病さや欲深さと良心が同居する、単純な悪人ではない人物として描かれた。", ["陳俊生"]),
    issue63Claim("C19", "陳俊生は放送当初『クズ男』と非難された後、『中国の良い元夫』と呼ばれるようになった。", ["陳俊生"])
  ],
  terms: [],
  japan_availability: { status: "not_in_evidence", detail: "", evidence_refs: [] },
  unresolved: [],
  evidence_quality: [
    { evidence_ref: "E1", classification: "ai_generated", usable_for_verified_facts: false, reason: "explicit_ai_generation_disclosure" },
    { evidence_ref: "E2", classification: "editorial_media", usable_for_verified_facts: true, reason: "editorial_source_without_integrity_markers" }
  ]
};

const issue63Topic = {
  topic_key: issue63Before.topic_key,
  main_entities: issue63Before.main_entities,
  source_mix: { media_report: 2 },
  evidence_articles: []
} as unknown as TopicCandidate;
const issue63Instruction = "二創→二次創作。注目ポイントが浅く理解が難しいため、再構成をする。";
const issue63Intent = detectReviewRevisionIntent(issue63Before, issue63Instruction, "用語");
assert.equal(issue63Intent.mode, "limited_patch");
assert.deepEqual(issue63Intent.required_replacements, [{
  before: "二創",
  after: "二次創作",
  target_fields: ["what_happened"]
}], "引用符のない矢印置換を必須修正として検出する");
assert.deepEqual(issue63Intent.required_field_rewrites, ["why_it_matters"], "注目ポイントの再構成をfield rewriteとして分離する");
assert.ok(issue63Intent.allowed_fields.includes("what_happened"));
assert.ok(issue63Intent.allowed_fields.includes("why_it_matters"));
assert.equal(
  detectReviewRevisionIntent(issue63Before, "記事内にない語→訂正語。", "用語").mode,
  "clarification_required",
  "明示置換の修正元が見つからない場合は推測で別箇所を直さない"
);

const multipleReplacementInstruction = "二創→二次創作。長年の沈黙→長い沈黙。";
const multipleReplacementIntent = detectReviewRevisionIntent(issue63Before, multipleReplacementInstruction, "用語");
assert.equal(multipleReplacementIntent.required_replacements.length, 2, "複数の矢印置換を順番にすべて抽出する");
for (const arrow of ["->", "-&gt;", "-&amp;gt;"]) {
  const entityIntent = detectReviewRevisionIntent(issue63Before, `二創${arrow}二次創作。`, "用語");
  assert.deepEqual(entityIntent.required_replacements, [{
    before: "二創",
    after: "二次創作",
    target_fields: ["what_happened"]
  }], `${arrow} をASCII矢印と同じ明示置換として受理する`);
}
assert.throws(
  () => applyValidatedReviewPatch(
    issue63Before,
    issue63Topic,
    issue63Ledger,
    multipleReplacementInstruction,
    "用語",
    multipleReplacementIntent,
    {
      mode: "limited_patch",
      clarification_required: false,
      clarification_reason: "",
      patches: [{ field: "what_happened", operation: "replace", before: "二創", after: "二次創作", evidence_claim_refs: [], reason: "1件目だけ修正" }]
    }
  ),
  ReviewRevisionClarificationRequiredError,
  "複数の明示置換のうち一部だけを処理して保存しない"
);

const groundedWhyItMatters = "陳俊生は不倫で羅子君と離婚した一方、離婚後も子どもや前妻一家を支え、再婚後には別の葛藤を抱えます。単純な悪人ではなく、臆病さや欲深さと良心が同居する人物だからこそ、「クズ男」から「中国の良い元夫」へ評価が揺れたところが面白いんです！";
const groundedRewritePatch = {
  field: "why_it_matters" as const,
  operation: "replace_field" as const,
  before: issue63Before.why_it_matters,
  after: groundedWhyItMatters,
  evidence_claim_refs: ["C15", "C16", "C17", "C18", "C19"],
  reason: "人物の行動と複雑さを結び、再評価が起きる理由を説明"
};

const omittedTermPatch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [groundedRewritePatch]
};
assert.throws(
  () => applyValidatedReviewPatch(issue63Before, issue63Topic, issue63Ledger, issue63Instruction, "用語", issue63Intent, omittedTermPatch),
  ReviewRevisionClarificationRequiredError,
  "複数指示の一部だけを反映したActions型出力を成功扱いにしない"
);

const shallowIssue63Patch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    { field: "what_happened", operation: "replace", before: "二創", after: "二次創作", evidence_claim_refs: [], reason: "用語を修正" },
    {
      field: "why_it_matters",
      operation: "replace_field",
      before: "LLMが返した現在値と不一致のbefore",
      after: `このドラマは、裕福で安逸な生活を送る専業主婦の${issue63Before.why_it_matters.replace("です！", "です。")}`,
      evidence_claim_refs: ["C13", "C15"],
      reason: "物語説明を追加"
    }
  ]
};
assert.throws(
  () => applyValidatedReviewPatch(issue63Before, issue63Topic, issue63Ledger, issue63Instruction, "用語", issue63Intent, shallowIssue63Patch),
  (error: unknown) => error instanceof ReviewRevisionClarificationRequiredError && /薄い追記・言い換え/u.test(error.message),
  "既存文の冒頭へ説明を足しただけの再構成を拒否する"
);

const issue63Patch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    { field: "what_happened", operation: "replace", before: "二創", after: "二次創作", evidence_claim_refs: [], reason: "用語を修正" },
    groundedRewritePatch
  ]
};
const issue63Result = applyValidatedReviewPatch(
  issue63Before,
  issue63Topic,
  issue63Ledger,
  issue63Instruction,
  "用語",
  issue63Intent,
  issue63Patch
);
assert.doesNotMatch(issue63Result.summary.what_happened, /二創/u);
assert.match(issue63Result.summary.what_happened, /二次創作/u);
assert.equal(issue63Result.summary.why_it_matters, groundedWhyItMatters);
assert.deepEqual(issue63Result.trace.changed_fields, ["what_happened", "why_it_matters"]);
assert.equal(issue63Result.summary.lead, issue63Before.lead);
assert.equal(issue63Result.summary.reaction_view, "");
assert.deepEqual(issue63Result.summary.source_list, issue63Before.source_list);
assert.deepEqual(issue63Result.summary.related_sources, issue63Before.related_sources);
assert.ok(issue63Result.summary.claim_refs.what_happened.includes("C1"));
assert.ok(issue63Result.summary.claim_refs.why_it_matters.includes("C19"));
assert.deepEqual(issue63Result.trace.preservation.important_numbers_after, issue63Result.trace.preservation.important_numbers_before);
assert.deepEqual(issue63Result.trace.preservation.entities_after, issue63Result.trace.preservation.entities_before);

const issue63Run326316Before: SummarizedArticle = {
  ...issue63Before,
  why_it_matters: "このドラマは、裕福で安逸な生活を送る専業主婦の羅子君が夫の陳俊生と離婚してすべてを失い、親友の唐晶とその彼氏の賀涵の助けで職場に入り、自己成長していく物語です。陳俊生は同僚の凌玲と不倫して羅子君と離婚し、凌玲と再婚します。この設定が、放送当時は「クズ男」と叩かれた陳俊生を、今では「中国の良い元夫」と呼ばせるほど視聴者の見方を変えたんです。"
};
const issue63Run326316GroundedWhy = "羅子君が離婚後に唐晶と賀涵の助けで職場へ踏み出し、自己成長する物語の一方で、その離婚を引き起こした陳俊生も単純な悪役には描かれません。陳俊生は不倫で羅子君と別れながら、離婚後も子どもや前妻一家を支え、再婚後には別の葛藤を抱えます。臆病さや欲深さと良心が同居する人物だからこそ、放送当初の「クズ男」から「中国の良い元夫」へ評価が揺れた。この割り切れなさが、時間を置いて見直す面白さなんです！";
const issue63Run326316Intent = detectReviewRevisionIntent(issue63Run326316Before, issue63Instruction, "用語");
const issue63Run326316Patch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    { field: "what_happened", operation: "replace", before: "二創", after: "二次創作", evidence_claim_refs: [], reason: "用語を修正" },
    {
      ...groundedRewritePatch,
      before: issue63Before.why_it_matters,
      after: issue63Run326316GroundedWhy,
      evidence_claim_refs: ["C13", "C15", "C16", "C17", "C18", "C19"]
    }
  ]
};
const issue63Run326316Result = applyValidatedReviewPatch(
  issue63Run326316Before,
  issue63Topic,
  issue63Ledger,
  issue63Instruction,
  "用語",
  issue63Run326316Intent,
  issue63Run326316Patch
);
assert.equal(
  issue63Run326316Result.summary.what_happened,
  issue63Run326316Before.what_happened.replace("二創", "二次創作"),
  "run 32631657560型でも明示用語置換だけを本文へ適用する"
);
assert.equal(issue63Run326316Result.summary.why_it_matters, issue63Run326316GroundedWhy);
assert.equal(
  issue63Run326316Result.trace.changes.find((change) => change.field === "why_it_matters")?.before,
  issue63Run326316Before.why_it_matters,
  "必須field rewriteのtraceにはLLM echoではなく保存記事の実際の現在値を記録する"
);
assert.deepEqual(issue63Run326316Result.trace.changed_fields, ["what_happened", "why_it_matters"]);
assert.equal(issue63Run326316Result.summary.reaction_view, issue63Run326316Before.reaction_view);
assert.deepEqual(issue63Run326316Result.summary.source_list, issue63Run326316Before.source_list);
assert.deepEqual(issue63Run326316Result.summary.related_sources, issue63Run326316Before.related_sources);
assert.deepEqual(issue63Run326316Result.trace.preservation.important_numbers_after, issue63Run326316Result.trace.preservation.important_numbers_before);
assert.deepEqual(issue63Run326316Result.trace.preservation.entities_after, issue63Run326316Result.trace.preservation.entities_before);

const issue63ActionsRetryPatch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [
    {
      field: "what_happened",
      operation: "replace",
      before: "二創",
      after: "二次創作",
      evidence_claim_refs: ["C2"],
      reason: "用語を修正"
    },
    groundedRewritePatch
  ]
};
const issue63ActionsRetryResult = applyValidatedReviewPatch(
  issue63Before,
  issue63Topic,
  issue63Ledger,
  issue63Instruction,
  "用語",
  issue63Intent,
  issue63ActionsRetryPatch
);
assert.doesNotMatch(issue63ActionsRetryResult.summary.what_happened, /二創/u);
assert.match(issue63ActionsRetryResult.summary.what_happened, /二次創作/u);
assert.equal(
  issue63ActionsRetryResult.summary.what_happened,
  issue63Before.what_happened.replace("二創", "二次創作"),
  "本文はOWNER指定の用語だけを置換する"
);
assert.equal(issue63ActionsRetryResult.summary.why_it_matters, groundedWhyItMatters);
assert.deepEqual(
  issue63ActionsRetryResult.trace.changes[0].evidence_claim_refs,
  [],
  "OWNERが明示した純粋な用語置換から、モデルが付けた不要なunsupported claim refだけを除去する"
);
assert.deepEqual(
  issue63ActionsRetryResult.summary.claim_refs.what_happened,
  issue63Before.claim_refs.what_happened,
  "用語置換は既存claim refsを保持し、新しい根拠refを追加しない"
);

const issue63ExpandedTermPatch: ReviewPatchDocument = {
  ...issue63ActionsRetryPatch,
  patches: [
    {
      ...issue63ActionsRetryPatch.patches[0],
      after: "二次創作（ファン制作コンテンツ）"
    },
    groundedRewritePatch
  ]
};
assert.throws(
  () => applyValidatedReviewPatch(
    issue63Before,
    issue63Topic,
    issue63Ledger,
    issue63Instruction,
    "用語",
    issue63Intent,
    issue63ExpandedTermPatch
  ),
  ReviewRevisionClarificationRequiredError,
  "明示置換を超える説明を足したパッチは純粋な用語置換とみなさず、利用不可refを除去して続行しない"
);

const issue63UnsupportedRewritePatch: ReviewPatchDocument = {
  ...issue63ActionsRetryPatch,
  patches: [
    issue63ActionsRetryPatch.patches[0],
    { ...groundedRewritePatch, evidence_claim_refs: ["C15", "C16", "C2"] }
  ]
};
assert.throws(
  () => applyValidatedReviewPatch(
    issue63Before,
    issue63Topic,
    issue63Ledger,
    issue63Instruction,
    "用語",
    issue63Intent,
    issue63UnsupportedRewritePatch
  ),
  ReviewRevisionClarificationRequiredError,
  "再構成へunsupported claimが混じった場合は、推測で差し替えたり除去して続行せずclarification_requiredで止める"
);

const noGroundingIntent = detectReviewRevisionIntent(issue63Before, "注目ポイントを再構成する。", "構成");
const noGroundingPatch: ReviewPatchDocument = {
  mode: "limited_patch",
  clarification_required: false,
  clarification_reason: "",
  patches: [{ ...groundedRewritePatch, evidence_claim_refs: [] }]
};
assert.throws(
  () => applyValidatedReviewPatch(
    issue63Before,
    issue63Topic,
    { ...issue63Ledger, claims: [] },
    "注目ポイントを再構成する。",
    "構成",
    noGroundingIntent,
    noGroundingPatch
  ),
  ReviewRevisionClarificationRequiredError,
  "根拠ある再構成を作れない場合は薄い修正を保存せずclarification_requiredで止める"
);

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
const issue63Prompt = buildLimitedReviewPatchPrompt(issue63Before, issue63Ledger, issue63Instruction, issue63Intent);
assert.match(issue63Prompt, /省略禁止の明示置換/u);
assert.match(issue63Prompt, /薄い追記/u);
assert.match(issue63Prompt, /根拠から実質的な改善を作れない場合.*clarification_required=true/u);
assert.equal(issue63Prompt.includes(issue63Ledger.claims[0].text), false, "unsupported claim本文をモデルの選択肢へ渡さない");
assert.equal(issue63Prompt.includes('"id": "C2"'), false, "利用不可claim IDをモデルの選択肢へ渡さない");
assert.equal(issue63Prompt.includes('"id": "C15"'), true, "再構成には利用可能claimだけを渡す");
assert.match(issue63Prompt, /明示置換.*evidence_claim_refs=\[\]/su, "用語の明示置換にはclaim refsを付けないよう明示する");
assert.match(issue63Prompt, /replace_field.*before.*空文字/su, "必須field rewriteで長い現在値をLLMにechoさせない");

const manualTopic = { ...topic, evidence_articles: [{ category: "持ち込みニュース" }] } as unknown as TopicCandidate;
const manualResult = applyValidatedReviewPatch(before, manualTopic, ledger, ownerInstruction, "事実", intent, patch);
assert.deepEqual(manualResult.summary, result.summary, "通常日次と持ち込みで同じ限定パッチ契約を使う");

console.log("scoped review revision tests passed.");
