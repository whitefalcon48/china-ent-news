# 設計: Phase 3a 事実台帳パイプライン（Fable 設計セッション 2026-07-13）

生成を「①事実台帳の抽出 → ②台帳のみからの執筆 → ③機械検査」へ分離する。
**この文書に沿って Codex が実装する。** 設計判断はすべて確定済み。実装中に迷ったら
仕様を変えず、この文書と `docs/design-phase3-content-pipeline.md`（方向確定 D1〜D7）に従う。

前提・確定済みユーザー要件（2026-07-13）:

- 見出しは「秘書の注目ポイント」（why_it_matters 改組）と「秘書からのひとこと」（editor_comment）
- 少女口調（「〜だね！」「〜みたいだよ！」）は秘書2セクションのみ。事実本文は通常文体
- 中国業界用語は初出時に短い日本語解説
- 日本公開・配信・字幕は台帳で確認できた場合のみ記載。「未公開」断定は全面禁止
  （実害事例: 给阿嬷的情书を「日本では未公開」と誤記。実際は面白映画配給で日本公開中）
- 一媒体の分析・将来予測は媒体名帰属 + 断定回避
- roadmap 2-4（出力の再定義）は本タスクに吸収する

## 全体像

```
topic選定（変更なし）
  → ① extractFactLedger（新 src/factLedger.ts、LLM 1回/topic）
  → ② 台帳から執筆（summarizeWithGemini.ts、LLM 1回/topic。原文rawContentは渡さない）
  → ③ runClaimCheck（新 src/claimCheck.ts、LLMなし純粋関数）
  → ゲート違反時: 違反文削除→再検査 → 執筆のみ再生成1回 → 棄却してbackfill
  → renderMarkdown（見出し改名 + priority順 + source_mix表示）
```

- LLM呼び出しは全体で **1実行45回まで**（`LLM_CALL_BUDGET` で変更可）。
  seedチャンク・台帳・執筆・再生成・backfill・fallback すべて含む
- 台帳抽出失敗時は現行の単段プロンプト（buildTopicPrompt）へ graceful fallback
- 脱出ハッチ: `FACT_LEDGER=false` で全体を現行単段生成へ戻す

## 実装項目（この順で。各ステップ後に `npm run check`）

### L1. 型追加（src/types.ts）

`MainEntities` 定義の後に追加:

```ts
export type ClaimType = "verified_fact" | "source_analysis" | "unsupported";

export type FactLedgerClaim = {
  id: string;                 // "C1".."C20"
  type: ClaimType;
  text: string;               // 日本語1文
  evidence_refs: string[];    // ["E1"] — buildTopicPrompt と同じ E 番号
  source_name?: string;       // source_analysis のとき必須（normalize で担保）
  entities: string[];         // 原文表記の固有名詞
  numbers: string[];          // 数字・日付の原文表記（例 "3.2亿", "6月30日"）
  quote_zh?: string;          // 原文アンカー30字以内
};

export type FactLedgerTerm = { term: string; gloss_ja: string };

export type JapanAvailability = {
  status: "verified" | "not_in_evidence";
  detail: string;
  evidence_refs: string[];
};

export type FactLedger = {
  topic_key: string;
  claims: FactLedgerClaim[];      // 最大20件
  terms: FactLedgerTerm[];        // 最大8件
  japan_availability: JapanAvailability;
  unresolved: string[];
};

export type ClaimRefs = {
  what_happened: string[];
  why_it_matters: string[];
  reaction_view: string[];
  japan_context_note: string[];
};

export type ClaimCheckRule =
  | "japan_availability_unverified"   // gate
  | "predictive_assertion_certain"    // gate
  | "number_not_in_ledger"            // 3aはwarning
  | "entity_not_in_ledger"            // 3aはwarning
  | "unsupported_generalization"      // 3aはwarning
  | "japan_comparison_no_claim"       // 3aはwarning
  | "unattributed_analysis"           // warning
  | "generic_comment"                 // warning
  | "banned_phrase_other";            // warning

export type ClaimCheckViolation = {
  section: string;                    // "what_happened" 等 + "lead" | "editor_comment"
  rule: ClaimCheckRule;
  severity: "gate" | "warning";
  detail: string;                     // 該当文の抜粋
};

export type ClaimCheckResult = {
  topic_key: string;
  violations: ClaimCheckViolation[];
  gated_violation_count: number;
  action: "none" | "text_removed" | "regenerated" | "discarded";
};

export type TopicGenerationMeta = {
  topic_key: string;
  ledger_used: boolean;
  ledger_fallback_reason: string;     // "" | "fact_ledger_disabled_env" | "ledger_extraction_failed:<detail>" | "llm_call_budget_exceeded"
  ledger?: FactLedger;                // output/fact_ledger_*.json 集約用
  claim_check?: ClaimCheckResult;
};
```

- `SummarizedArticle` に `claim_refs: ClaimRefs;` を追加
- `ProcessedArticle` に `generationMeta?: TopicGenerationMeta;` を追加
- `secretary_inference` は台帳の ClaimType に**入れない**（3b のコメント工程が追記する分類。
  4分類のうち3aで扱うのは上記3つ）

### L2. normalizeSummary の claim_refs 対応（src/summarizeWithGemini.ts）

- `normalizeSummary` の返却値に `claim_refs: normalizeClaimRefs(value.claim_refs)` を追加
- `normalizeClaimRefs`: 4キーそれぞれに既存 `ensureStringArray` を適用、欠落は空配列
- **fallback プロンプトの雛形から claim_refs を除外する**: `buildTopicPrompt` は返すJSON雛形を
  `JSON.stringify(normalizeSummary({}), ...)` で自動生成しているため、`claim_refs` 追加が
  そのまま混入すると、説明のないフィールドをLLMが不定に埋める。
  `const { claim_refs, ...fallbackTemplate } = normalizeSummary({});` のように分解して
  雛形からは除く（単段経路では claim_refs は常に normalizeClaimRefs の空配列になる）
- ここで一度 `npm run check` を通す（型追加の影響範囲を閉じる）

### L3. LLM呼び出しバジェット（新規 src/llmCallBudget.ts）

```ts
export type LlmCallBudget = { limit: number; used: number };
export function createLlmCallBudget(limit = Number(process.env.LLM_CALL_BUDGET || 45)): LlmCallBudget;
export function hasLlmBudgetRemaining(budget: LlmCallBudget): boolean;
export class LlmCallBudgetExceededError extends Error {}
export function consumeLlmCall(budget: LlmCallBudget): void; // 残量なしなら throw、あれば used++
```

- `summarizeWithGemini.ts` の `generateJson` / `generateGeminiJson` / `generateDeepSeekJson` に
  `budget?: LlmCallBudget` を追加し、呼び出し前に `budget && consumeLlmCall(budget)`。
  未指定なら従来どおり無制限（testGemini.ts / testDeepSeek.ts に影響なし）
- `summarizeArticle` にも `budget?` を追加して素通しする（レガシー経路の下位互換）

### L4. renderMarkdown の改修（src/renderMarkdown.ts）— 2-4 吸収

1. 見出し変更: `### なぜ話題？` → `### 秘書の注目ポイント`、`### ひとこと` → `### 秘書からのひとこと`
2. 並び順: `publish_priority` 順（high→medium→low）→ 同値は `newsworthiness_score` 降順
3. メタ行の次に source_mix 行を追加: `topic.source_mix` から
   `ソース構成: 公式N・媒体N・SNS N・データN` 形式で出力。
   表示は4分類へ畳む（意図的な単純化）: 公式=official+pr_like / 媒体=media_report+mixed /
   SNS=sns+rumor / データ=data。
   「公式」件数 > 0 かつ他3分類の合計 0 の場合は `（公式発表のみ・裏付けなし）` を付記。
   topic が無い記事経路では `summary.source_type` から1件相当の簡易表記に fallback
4. **この L4 の変更は `FACT_LEDGER` の設定に関わらず常時適用する**
   （脱出ハッチの対象は生成ロジック〈台帳・執筆・検査〉のみ。出力フォーマットは戻さない）

### L5. editorial-character.md への追記（文面確定・そのまま追記する）

`docs/editorial-character.md` の末尾に以下をそのまま追加する:

```markdown
## 秘書キャラクターの適用範囲と口調

- このサイトの語り手は「運営者の秘書」キャラクター。人格は「知ったかぶりをしないが、何を見るべきかは判断できる人」。
- 秘書が担う役割:
  - このニュースのどこが気になるかを言う
  - 何が確認できれば評価を変えられるかを示す
  - ニュースの大きさではなく、何の変化を示す材料なのかを見る
  - 現時点で言えることと、まだ言えないことの境界を引く
  - 今後追うべき数字、発表、作品、興行、反応を挙げる
- 出力セクションのうち「秘書の注目ポイント」「秘書からのひとこと」だけは秘書の声で、基本的な少女口調（「〜だね！」「〜みたいだよ！」）で書く。
- 事実本文（リード、何が起きた？、反応・見られ方、日本語圏では見えにくいポイント）は通常の報道文体を維持し、口調を混ぜない。
- キャラクター名は未定。決定までは見出しを「秘書の注目ポイント」「秘書からのひとこと」とする。

## 表現の規律

- 中国固有の業界用語（备案、定档、路演、控评、番位など）は、初出時に短い日本語解説を付ける。
- 日本公開・配信・日本語字幕の有無は、事実台帳または検索結果で確認できた場合だけ書く。確認できない場合は「未公開」と断定せず、「日本での公開情報は今回の情報源からは確認できていない」に留めるか、触れない。
- 一媒体の分析や将来予測は、必ず媒体名へ帰属させ、断定しない。
  - 悪い例: 「過去の古偶一強から多様化へのシフトが鮮明」
  - 良い例: 「新浪エンタメは、古偶一強から多ジャンル化へ動いていると見ているみたいだよ！」
- 予測を「確実」と断定しない。「大ヒット確実」型の表現は使わない。
- 「注目される」「期待される」だけで中身のないコメントを書かない。
```

（この文書はプロンプトが毎回読み込むため、コード変更なしで全生成工程に効く）

### L6. 事実台帳の抽出（新規 src/factLedger.ts）

構造は `src/topicSeeds.ts` を踏襲（自前の generateGeminiJson / generateDeepSeekJson /
parseJsonFromModelText を持つ。共通化リファクタはしない）。

```ts
export type FactLedgerExtractionResult = { succeeded: boolean; ledger?: FactLedger; error: string };
export async function extractFactLedger(
  topic: TopicCandidate, evidence: RawArticle[], provider: AiProvider, budget?: LlmCallBudget
): Promise<FactLedgerExtractionResult>;
export async function writeFactLedgerFile(
  ledgers: Array<{ topic_key: string; ledger: FactLedger | null; fallback_reason: string }>
): Promise<string>; // output/fact_ledger_YYYY-MM-DD.json（writeTopicCandidatesFile と同パターン）
```

- **evidence 整形の共通化（必須）**: `summarizeWithGemini.ts` の buildTopicPrompt 内の
  evidence 整形部（`[E1]（代表）source: ... 本文: ...`、代表5000字・他1500字）を
  `export function formatEvidenceForPrompt(evidence: RawArticle[]): string` として切り出し、
  buildTopicPrompt と factLedger.ts の両方から呼ぶ。
  **E番号が台帳の evidence_refs と一致することが検査の前提**なので、整形の二重実装は禁止
- max_tokens: DeepSeek `max_tokens: 8000` / Gemini `maxOutputTokens: 8192`（topicSeeds と同値）
- **バジェット消費（漏らさない）**: factLedger.ts 内の自前 generateGeminiJson / generateDeepSeekJson を
  呼ぶ直前に `budget && consumeLlmCall(budget)` を必ず入れる（L3 は summarizeWithGemini.ts 側の
  関数にしか consume を入れないため、ここを漏らすと台帳呼び出しが45回上限にカウントされない）
- `normalizeFactLedger(parsed, topic.topic_key)`: claims を最大20件に切り詰め、
  `source_analysis` なのに `source_name` 空の claim は `unsupported` に格下げ、
  `japan_availability` 欠落時は `{ status: "not_in_evidence", detail: "", evidence_refs: [] }`
- 例外はすべて捕捉して `{ succeeded: false, error: describeError(error) }` を返す。
  ただし `LlmCallBudgetExceededError` は error 文字列に `llm_call_budget_exceeded` を含める
  （呼び出し元が fallback を呼ぶべきでないことを判定する規約）

**台帳抽出プロンプト（文言確定・変更しない）**:

```text
あなたは中国エンタメニュースの事実整理AIです。1つのトピックと複数のevidenceから、後工程が日本語記事を書くための「事実台帳」をJSONで作ります。

最重要ルール: 後工程はこの台帳だけを使って記事を書き、台帳に無い情報は一切書けません。evidenceにある重要情報を漏らさず、evidenceに無い情報を混ぜないでください。

claimの分類（type）:
- verified_fact: evidenceに直接書かれている日付・数字・人物・組織・出来事。
- source_analysis: 元媒体による分析・見方・評価・将来予測。source_name（媒体名）を必ず入れる。
- unsupported: evidence中に現れるが根拠が確認できない情報（伝聞、真偽不明の噂など）。記事には使われない。

規則:
- claimは1件1文。重要な順に最大20件。
- entities（人物・作品・組織の固有名詞）とnumbers（数字・日付）は原文の表記のまま入れる。
- quote_zhには根拠となる原文の該当箇所を30字以内で入れる。
- evidence_refsには根拠のevidence番号（"E1"など）を必ず入れる。
- 日本での公開・配信・日本語字幕に関する情報がevidenceに明示されている場合のみ、japan_availabilityのstatusを "verified" にし、detailに内容、evidence_refsに根拠を入れる。evidenceに無ければ status は "not_in_evidence"、detailは空文字。推測で "verified" にしない。日本に関する言及が無いことは「日本未公開」を意味しない。
- 中国エンタメ業界の用語（备案、定档、路演、控评、番位、飯圏など）のうち、日本の読者に説明が必要なものを terms に入れる（最大8件、gloss_jaは20字以内）。
- evidence間で数字・日付・事実が食い違う場合は unresolved に1行で記す。どちらかへ勝手に寄せない。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "topic_key": "<入力値をそのまま>",
  "claims": [{ "id": "C1", "type": "verified_fact", "text": "", "evidence_refs": ["E1"], "source_name": "", "entities": [], "numbers": [], "quote_zh": "" }],
  "terms": [{ "term": "", "gloss_ja": "" }],
  "japan_availability": { "status": "not_in_evidence", "detail": "", "evidence_refs": [] },
  "unresolved": []
}
```

（プロンプト末尾に入力トピック情報〈topic_key / event_sentence / topic_type〉と
`formatEvidenceForPrompt(evidence)` の結果を付ける）

### L7. 機械検査（新規 src/claimCheck.ts）— LLMなし・純粋関数

```ts
export function runClaimCheck(summary: SummarizedArticle, ledger: FactLedger): ClaimCheckResult;
export function removeGatedViolationSentences(
  summary: SummarizedArticle, violations: ClaimCheckViolation[]
): SummarizedArticle;
export class ClaimCheckDiscardError extends Error {}
```

検査対象セクション: `lead` / `what_happened` / `why_it_matters` / `reaction_view` /
`japan_context_note` / `editor_comment`。文分割は「。」「！」「？」区切り。

**ゲート（severity: "gate"）— 3aで即時発動する2種のみ**:

1. `japan_availability_unverified`:
   日本での公開・配信・字幕を**断定する文**を検出したら、`ledger.japan_availability.status === "verified"`
   でない限り gate。検出regex（否定断定 — status に関わらず常に gate。否定はevidenceから証明不能）:
   `/日本では?未公開|日本未公開|日本未上陸|日本では(まだ)?(公開|配信|上映)されていない/`
   肯定断定（`/日本で(公開|配信|上映)(中|されている|が決定)/` 等）は status=verified なら通す
2. `predictive_assertion_certain`: `/大ヒット確実|ヒット確実|成功確実|確実視|間違いない|必至/`

**警告（severity: "warning"）— trace記録のみ、3bでゲート化予定**:

- `number_not_in_ledger`: 本文中の数字トークンが台帳の numbers に無い。
  正規化関数 `normalizeNumberToken` を実装（全角→半角、`億`↔`亿`、カンマ除去。
  「3.2億元」と「3.2亿」を同一視できる程度でよい。年月日は「6月30日」形式へ寄せる）
- `entity_not_in_ledger`: 本文中の固有名詞らしき連続漢字列（《》内・台帳entitiesとの部分一致で判定）が台帳に無い
- `unsupported_generalization`: `/これまで.{0,12}(なかった|存在しなかった)|統一基準がなかった|業界初|史上初|中国では一般的/` で対応claimなし
- `japan_comparison_no_claim`: 「日本」を含む比較文（`japan_context_note` 以外のセクション）で
  claim_refs の参照先に日本関連claimが無い
- `unattributed_analysis`: `/が鮮明|とみられる|とされる/` を含む文で、そのセクションの claim_refs に
  `source_analysis` claimが無い、または文中に媒体名が無い
- `generic_comment`: `editor_comment` が `/注目|期待|目が離せない/` を含み、かつ40字未満
- `banned_phrase_other`: `/〜?活性化|が加速/` 等の趨勢断定（初版は `活性化|が加速` のみ）

`removeGatedViolationSentences`: 違反文（violation.detail を含む文）をセクションから除去。
セクションが空になったら空文字にする（renderMarkdown は空セクションを非表示にする既存挙動）。

### L8. summarizeTopic の2段化（src/summarizeWithGemini.ts）

シグネチャ変更（呼び出し元は src/index.ts の1箇所のみ）:

```ts
export async function summarizeTopic(
  topic: TopicCandidate, evidence: RawArticle[],
  provider: AiProvider = getAiProvider(), budget?: LlmCallBudget
): Promise<{ summary: SummarizedArticle; meta: TopicGenerationMeta }>
```

フロー:

1. `process.env.FACT_LEDGER === "false"` → 台帳を呼ばず現行単段（buildTopicPrompt）。
   `meta = { ledger_used: false, ledger_fallback_reason: "fact_ledger_disabled_env" }`
2. `extractFactLedger(...)` 失敗時:
   - error に `llm_call_budget_exceeded` を含む → fallback を**呼ばず** throw
     （index.ts の既存 catch → ai_error 扱い。backfill は L10 のバジェットガードで止まる）
   - それ以外 → 現行単段へ fallback。`ledger_fallback_reason = "ledger_extraction_failed:" + error`
3. 成功 → `buildLedgerWritingPrompt(topic, ledger)` で執筆（LLM 1回）。
   **原文 rawContent・excerpt は執筆プロンプトに入れない**
4. `runClaimCheck(summary, ledger)` → gate 違反あり:
   ① `removeGatedViolationSentences` → 再検査（action: "text_removed"）
   ② まだ gate 違反 → 執筆のみ再生成1回（action: "regenerated"、budget消費）。
      `buildLedgerWritingPrompt(topic, ledger, violations?)` に optional 第3引数を持たせ、
      違反がある場合のみプロンプト末尾に次の確定文言を付ける（他の文言は変えない）:
      「前回の出力に次の禁止表現が含まれていました。該当の内容を含めずに書き直してください:
      <violations の rule と detail を1行ずつ列挙>」
   ③ まだ gate 違反 → `ClaimCheckDiscardError` を throw（action: "discarded"）
5. `mergeTopicInternalMetadata(...)` は変更せずそのまま通す
6. 単段 fallback 経路でも claim_check は実行**しない**（台帳が無く照合できないため。
   meta.claim_check は undefined のまま）

**台帳執筆プロンプト（文言確定・変更しない）**:

```text
あなたは中国エンタメの日本語ニュースメモを書く編集AIです。入力は「事実台帳」だけです。元記事の原文はもう見られません。

Editorial character policy document (docs/editorial-character.md):
<editorial文書をここに挿入>

Use the document above as the highest-priority editorial policy.

最重要ルール:
- 台帳のclaimsにある情報だけで書く。台帳に無い数字・日付・人物・作品・出来事・背景説明を足さない。
- type: unsupported のclaimは本文に使わない。
- type: source_analysis のclaimを使う文は、必ずsource_nameの媒体名を主語または出典として明示し、断定しない（「〜みたい」「〜と見ている」）。業界全体の事実のように書かない。
- 日本での公開・配信・字幕は、japan_availability.status が "verified" の場合だけ、detailの範囲で書く。"not_in_evidence" の場合は「日本では未公開」と書かず、触れないか「日本での公開情報は今回の情報源からは確認できていない」とする。
- termsにある用語を本文で使う場合、初出時に「用語（gloss_ja）」の形で短い解説を付ける。
- unresolvedにある食い違いは、どちらかへ寄せず「E1では○○、E2では△△」と併記するか、触れない。
- 予測を「確実」と断定しない。

文体:
- lead / what_happened / reaction_view / japan_context_note は通常の報道文体。
- why_it_matters（見出し「秘書の注目ポイント」）と editor_comment（見出し「秘書からのひとこと」）だけは、秘書キャラクターの声で、基本的な少女口調（「〜だね！」「〜みたいだよ！」）で書く。
- 秘書の口調でも、内容は editorial 文書の秘書の役割（何を見るべきか・確認ポイント・追うべき数字）に沿わせる。感想や煽りだけのコメントにしない。

構成ルール:
- lead: 2〜3行。トピック全体として何が起きたか。
- what_happened: 150〜250字。verified_fact claimだけで出来事・数字・日付・関係者を整理。
- why_it_matters: 100〜200字。秘書の注目ポイント。「何が確認できれば評価が変わるか」「今後追うべき数字・発表」を秘書口調で。what_happenedの言い換えをしない。
- reaction_view: SNS由来または複数媒体のclaimがある場合のみ100〜200字。無ければ空文字。
- japan_context_note: 日本語圏で見えにくい文脈のclaimがある場合だけ。無ければ空文字。
- editor_comment: 1〜2文の短い秘書のひとこと。why_it_mattersと同じ内容を繰り返さない。
- 本文合計はおおむね400〜700字。
- claim_refs に、各セクションで根拠にしたclaimのidを入れる（例: {"what_happened": ["C1","C2"], ...}）。
- 必ずJSONだけを返す。
```

（返すJSONの雛形は既存 `normalizeSummary({})` のJSONに `claim_refs` の4キーを加えたもの。
入力として topic_key / event_sentence / source_mix / freshness と、台帳JSON全体を付ける）

### L9. topicSeeds のバジェット対応（src/topicSeeds.ts）

- `extractTopicSeeds` に `budget?: LlmCallBudget` を追加、チャンク呼び出し前に consume。
- 残量が尽きたら残チャンクはAPIを呼ばず regex fallback シードで続行

### L10. index.ts の接続

- `main()` 冒頭で `const llmCallBudget = createLlmCallBudget();`、
  `extractTopicSeeds` / `summarizeTopic` / `summarizeArticle` に引き回す
- 生成ループの呼び出し部は次の形に書き換える（**2-3c H3 の unknown 救済ロジック
  〈`summary.article_type === "unknown" && !summary.skip_reason` → `getRescuedTopicArticleType`〉と
  `isPublishableType` 判定・`postAiExclusions`・`topicFailures` の既存分岐は、参照変数名を
  合わせるだけで中身を変えない**。summarizeArticle の戻り値は従来どおり SummarizedArticle 単体）:

  ```ts
  let summary: SummarizedArticle;
  let generationMeta: TopicGenerationMeta | undefined;
  if (topic) {
    const result = await summarizeTopic(topic, evidence, provider, llmCallBudget);
    summary = result.summary;
    generationMeta = result.meta;
  } else {
    summary = await summarizeArticle(article, provider, llmCallBudget);
  }
  // 以降の H3 救済・isPublishableType 判定・postAiExclusions は summary をそのまま参照（変更なし）
  ```

- `processed.push({ raw: article, summary, topic, generationMeta })`
- catch 節: `ClaimCheckDiscardError` は `topicFailures.push({ stage: "claim_check_gate", reason: <violation要約> })`
  として backfill を呼ぶ。`LlmCallBudgetExceededError` は `reason: "llm_call_budget_exceeded"`
  （`topicFailures` の stage 型に `"claim_check_gate"` を追加）
- `enqueueTopicBackfill` 冒頭に `if (!hasLlmBudgetRemaining(llmCallBudget)) return;` を追加
  （超過時は新規 backfill を止め、処理済み分で出力する）
- ループ後: `processed` から `generationMeta.ledger` を集約して `writeFactLedgerFile(...)` を呼ぶ
  （fallback だった topic も `{ ledger: null, fallback_reason }` で記録する）

### L11. selection trace の拡張（src/selectionTrace.ts, src/index.ts）

- trace に追加:
  - `claim_check`: topic別の `{ topic_key, ledger_used, ledger_fallback_reason, violations, action }` 配列
  - `llm_call_budget`: `{ limit, used }`
- `topic_selection.failed` の stage 型に `"claim_check_gate"` を追加
- 既存の診断項目を壊さない（AGENTS.md 設計原則6）

## 受け入れ基準

1. Actions(deepseek) 実行で、生成された topic の `ledger_used: true` 比率が **8割以上**。
   fallback になった topic は trace の `ledger_fallback_reason` で理由が追える
2. `output/fact_ledger_YYYY-MM-DD.json` が生成され、claims に evidence_refs と type が付いている
3. 出力 Markdown に「日本では未公開」型の断定が無い。日本公開情報は verified の場合のみ
4. 見出しが「秘書の注目ポイント」「秘書からのひとこと」になり、その2セクションのみ少女口調、
   事実本文は通常文体
5. 記事が publish_priority 順に並び、各記事に source_mix 行が出る（2-4 吸収分）
6. claim_check の violations が trace に記録される（warning はゲートせず記録のみ）
7. `FACT_LEDGER=false` で**生成ロジックのみ**現行同等の単段生成に戻る
   （L4 の出力フォーマット変更〈見出し・並び順・source_mix〉は維持される）
8. trace の `llm_call_budget.used` ≦ 45。官庁比率 ≦ 50% / 媒体 fresh > 0 /
   最終出力本数・複数ソース topic 数が前回から後退しない

## 検証手順

1. `npm run check`（各実装ステップ後）
2. ローカル（LLM不要分）:
   - claimCheck: scratchpad に一時スクリプトを書き、ダミー SummarizedArticle + FactLedger で
     「日本で配信中」+ not_in_evidence → gate / 「大ヒット確実」→ gate /
     台帳外の数字 → warning / removeGatedViolationSentences の文削除、を確認（スクリプトはコミットしない）
   - renderMarkdown: ダミー ProcessedArticle で見出し・並び順・source_mix 行を確認
3. `npm run start`（ローカル、APIキーなし）: regex fallback 経路で trace に
   `llm_call_budget` が出ること、既存診断が壊れていないことを確認
4. push → Actions(deepseek) で受け入れ基準 1〜8 を確認
5. roadmap 更新（3a ✅ + 実測値1行）→ コミット

## やらないこと

- 秘書コメントの別工程化（3b。editor_comment は3aでは執筆プロンプト内で生成）
- warning 検査のゲート化（3bで、trace観察後に判断）
- analysis_feature の解禁（3c。F5 の skip は維持）
- テストフレームワーク導入・HTTP呼び出しの共通化リファクタ
- 日本語圏可視性の検索実測（2-6）
