# 設計: Phase 3b 読者ファースト品質修正（Fable 設計セッション 2026-07-18）

2026-07-18 の Actions(deepseek) 実出力・selection trace・topic candidates・fact ledger（`data/2026-07-18/`）の
原因分析に基づく設計。**この文書に沿って Codex が実装する。** 設計判断はすべて確定済み。
迷ったら仕様を変えずこの文書と `docs/design-phase3-content-pipeline.md` / `docs/design-phase3a-fact-ledger.md` に従う。
目的は「読者が理解できるニュースへの品質修正」であり、①ビンタンコメントの噛み砕き・トーン修正 ②用語解説
③表記辞書 ④情報完全性ゲート ⑤claimCheck のゲート化判断（= Phase 3 計画の D4/D5/D6 の残り）を含む。
3c の analysis_feature 解禁と Phase 4 サイト UI には触れない。

## 1. 原因分析（2026-07-18 実測）

### 1-A. 口調

- 実測: 10記事すべてでビンタンコメント欄（注目ポイント＋ひとこと）の「！」が0個。コメントは本文の言い換え＋抽象的な締めで、「今後の動向を追いたい」「注目したいですね」型の定型句が10記事中8記事に出現。
- 原因1: Phase 3 計画 D4（コメント分離工程）が未実装で、執筆1回で本文＋コメントを同時生成しており、コメントが報道文体に引きずられる。
- 原因2: editorial-character.md の感嘆符規定が「1コメント2個まで」という上限のみで下限・推奨温度がなく、temperature 0.1 の DeepSeek は安全側（0個）に収束する。
- 原因3: 「要するに読者にとって何が起きたか」を平易に言う構造指定がない。

### 1-B. 用語解説

- terms は gloss_ja（20字上限）の直訳のみ（例: 分段密钥→分割キー）。「それが何か」「なぜ重要か」を運ぶフィールドがない。執筆プロンプトの指示も「用語（gloss_ja）」の括弧書きのみ。
- 偷票房トピックの台帳には説明材料が存在した（C4〜C7: 白紙チケット報告・映画館側の説明・分段密钥導入の目的、C17〜C18: 媒体分析）のに、記事に展開されなかった。今回は素材不足ではなく、器（スキーマ）と指示（プロンプト）の問題。
- terms のプロンプト例丸写し: 群星闪耀时・红色微短剧展の terms に、プロンプトの例示語「备案・定档・路演・控评・番位・饭圈」がそのまま入っている（本文に登場しない語）。
- 蔡赴朝の台帳 claims が全文中国語（プロンプトに日本語指定がない）。terms も「两个确立→習近平の核心地位と思想の指導的地位の確立」のような政治用語直訳で、読者向けの噛み砕きになっていない。

### 1-C. 事実台帳

- ledger_used 10/10（3a 受け入れ基準①達成）、llm_call_budget 24/45（seed 4＋台帳10＋執筆10）。
- japan_availability は全件 not_in_evidence、日本未公開断定なし（基準③達成）。
- ただし台帳外の数字が公開された: 郎朗記事「120億回以上のストリーミング再生」に対し台帳は「12亿次」— 10倍の誤り。warning のまま公開（実害）。
- 数字が claim.numbers に入らず text / entities 側にだけある形式ゆれが多い（「第八届」は entities、「这两年」は text 内など）。照合先が numbers 配列だけの現行実装では偽陽性を量産する。

### 1-D. claimCheck

- 実測: warning 13件（number_not_in_ledger 10 / japan_comparison_no_claim 3）、gate 0件、action すべて none。
- number の内訳: 真陽性1（郎朗 120億回 vs 台帳 12亿次）、偽陽性9（日付形式 2026-07-15 vs 2026年7月15日、漢数字 十五次 vs 15回、第八届 vs 第8回、単位ゆれ 次 vs 回、照合先不足）。
- japan_comparison 3件は全て偽陽性: サイト自身の編集フレーム「日本語圏では報じられない／見えにくい」を日本比較と誤認。
- 検出漏れ: 袁娅維「ファンからは好意的な反応が予想されます」（SNS evidence なしの反応予測）、群星闪耀时「初共演は初めてではないでしょうか」（未確認推測）、「今後の動向に注目」型定型句（generic_comment は editor_comment 40字未満のみ対象のため一度も発火せず）。

### 1-E. topic 選定 / final_fill

- 大哥: seed_confidence 0.2 / topic_type unknown / main_entities は people・works・events 空、organizations は出典媒体名「新浪娱乐」のみ / event_sentence は「新浪娱乐が『（タイトル）』という記事を掲載した」というタイトル言い換え / final_fill で採用。
- 候補85件中 seed_confidence ≦0.4 が15件あり、すべて主語不明のクリックベイト型（田园农场风、爹地每次拍完照妈咪就这样、女大十八变、还以为她挣了很多钱 等）。うち fresh は3件。
- 選定10件は大哥以外すべて confidence ≧0.8。プール内の正常候補の最低値は 0.7。→ 閾値 0.5 で正常候補を巻き込まずジャンクを落とせる。
- final_fill 自体は設計どおり動作（蔡赴朝・群星も final_fill で妥当な採用）。問題は候補プールにジャンクが残ること。既存の本文量ガード（MIN_RAW_CONTENT_LENGTH 180）は「本文はあるが主語が特定できない」記事を通してしまう。
- 維持ラインのベースライン（2026-07-18 実測）: 候補プール84件、官庁比率 20.2%（17/84）、媒体 fresh 34件、複数ソース topic 1件、最終出力10本。

## 2. 設計判断（3b-D1〜3b-D10）

- **3b-D1 コメント分離工程**（Phase 3 計画 D4 の実装）: 本文確定・claim_check 通過後に、ビンタンコメント（why_it_matters＋editor_comment）を専用プロンプトで別生成（+1呼び出し/topic）。入力は完成本文＋事実台帳＋トーンモード。執筆段でも従来どおりコメントを生成しておき、コメント工程失敗時はそれをそのまま使う（graceful fallback、出力 JSON 形状は不変）。
- **3b-D2 トーンモード**: 純関数 `getToneMode(topic, ledger)` → `"normal" | "sober"`。sober＝重大事件・法的問題・訃報・被害者のいる話題（中日両言語のキーワード判定）。normal は「！」2〜3個目標・1文1個まで、sober は0個。機械検査＋決定的サニタイズで担保。
- **3b-D3 用語解説は「台帳抽出の強化」で対応**。追加検索・記事保留は不採用。理由: 2026-07-18 実測では説明材料は evidence 内に存在しており、不足していたのは①材料を用語説明として構造化するフィールド ②執筆・コメントプロンプトの展開指示。追加検索は呼び出し増とスコープ拡大（2-6・3c と衝突）、保留は本数への影響が大きすぎる。材料が台帳にない場合は一般知識で補完せず「〜の仕組みは今回の情報源では説明されていない」と明示するか用語を使わない（プロンプトで規定）。terms を `{ term, gloss_ja(20字), what_is(40字以内・evidenceにある場合のみ), why_now(60字以内・同) }` に拡張し、中心用語の説明 claim 化を義務付け、例示語丸写しを禁止、normalize 時に evidence 本文に出現しない term を決定的に除去。
- **3b-D4 表記辞書**: `config/terminology.json`（新規）＋ `src/terminology.ts`（新規）。4分類: preferred_names（優先表記・決定的置換）/ known_terms（そのまま使う既知語）/ first_gloss_terms（初出時だけ補足）/ always_explain_terms（毎回説明必須）。preferred_names の置換は生成後の決定的後処理（LLM 任せにしない）。初出「広電局（国家广播电视总局）」、以降「広電局」。
- **3b-D5 情報完全性ゲート**: `src/completenessGate.ts`（新規・純関数）。selectTopicsForAi の eligible 構築時に評価し、不合格は dropped に `information_incomplete:<理由>` で記録。final_fill・backfill も同じ eligible を使うため自動的にゲート対象。品質を満たす候補が足りない日は10本未満を許容（埋め直し・救済をしない）。脱出ハッチ `INFO_COMPLETENESS_GATE=false`。
- **3b-D6 claimCheck 改修**: ①数字正規化強化（漢数字・日付形式・序数・単位）②照合先を claim.numbers＋text＋entities＋quote_zh に拡大 ③金額・完全日付など高リスク数字のみ gate 昇格、その他は warning 維持 ④japan_comparison の正規表現を実比較に絞り warning 維持 ⑤コメント欄専用の新検査（反応捏造・未確認推測・定型句・感嘆符）はコメント工程内 gate（再生成はコメントのみで安価）。
- **3b-D7 台帳抽出プロンプト改訂**: 日本語明記・中心用語説明の claim 化・terms 例丸写し禁止・terms フィールド拡張。3a の「文言確定・変更しない」を本設計で supersede する。
- **3b-D8 LLM budget 既定 45→60**: 実測24＋コメント10＋再生成/backfill 余地。`LLM_CALL_BUDGET` で変更可は維持。
- **3b-D9 editorial-character.md 口調規定改訂**: 感嘆符の推奨温度（上限だけでなく目標）・語尾例・「要するに」構造・短文・定型句禁止を追記（確定文面は実装手順 B1）。
- **3b-D10 脱出ハッチの判断**: `COMMENT_STAGE=false`（コメント工程を止めて 3a 相当へ）と `INFO_COMPLETENESS_GATE=false`（ゲート無効化）を新設する。`FACT_LEDGER=false` は維持。claimCheck の gate 昇格には専用ハッチを設けない — 判断理由: 違反文削除→再生成→棄却の既存劣化ポリシーで出力本数は守られ、誤爆が観測された場合は正規表現側を緩めるのが正しい対処のため。

## 3. 変更対象ファイル

| ファイル | 変更 |
|---|---|
| docs/editorial-character.md | 口調規定の改訂（B1） |
| config/terminology.json | 新規（B2） |
| src/terminology.ts | 新規（B2） |
| src/types.ts | FactLedgerTerm 拡張・ClaimCheckRule 追加・ToneMode・CommentStageMeta（B3） |
| src/factLedger.ts | プロンプト改訂・normalize 拡張（B4） |
| src/claimCheck.ts | 正規化強化・照合先拡大・gate 昇格・runCommentCheck 追加（B5, B8） |
| src/toneMode.ts | 新規（B6） |
| src/summarizeWithGemini.ts | 執筆プロンプト改訂・コメント工程追加（B7） |
| src/completenessGate.ts | 新規（B9） |
| src/index.ts | ゲート接続・trace 拡張（B9, B10） |
| src/selectionTrace.ts | information_gate・comment_stage・budget 60（B10） |
| src/llmCallBudget.ts | 既定値 60（B10） |
| src/qualityReport.ts + package.json | 品質レポート（B11） |
| docs/roadmap.md | Phase 3b 状況更新（B12） |

## 4. 実装手順（B1〜B12。各ステップ後に `npm run check`）

### B1. editorial-character.md 口調規定改訂

「秘書キャラクター「冰糖（ビンタン）」の適用範囲と口調」セクション内の次の2行を差し替える。

旧:
「- 出力セクションのうち「ビンタンの注目ポイント」「ビンタンからのひとこと」だけは秘書の声で書く。口調は「です・ます調」を基本とし、明るく、少し前のめりに。「〜ですね」「〜ですよ」などの柔らかい語尾で親しみを出す。タメ口語尾（「〜だね」「〜だよ」等）は使わない。」
「- 感嘆符は1コメント2個まで。重大事件・法的問題・訃報では感嘆符とツッコミを使わず、落ち着いた文体に切り替える。」

新（確定形・一字どおり）:

```markdown
- 出力セクションのうち「ビンタンの注目ポイント」「ビンタンからのひとこと」だけは秘書の声で書く。口調は話し言葉に近い「です・ます調」を基本とし、明るく、少し前のめりに。コメント欄は事実本文を難しく言い換える場所ではなく、難しい中国エンタメの事情を読者に噛み砕いて渡す場所である。タメ口語尾（「〜だね」「〜だよ」等）は使わない。
- 使ってよい語尾の例: 「〜ですね！」「〜なんです！」「〜ですよ〜！」「〜ですって！」「〜ましたね〜！」「要するに、〜ということです！」
- 「ビンタンの注目ポイント」の最初の1文は、読者にとって「要するに何が起きているのか」を前提知識ゼロで分かる平易な言葉で言う。抽象的な分析はその後に置く。
- 一文は短く切る（コメント欄は50字以内目安）。抽象語より具体的な数字・出来事・確認ポイントを優先する。
- 感嘆符は、通常のエンタメ記事ではコメント欄全体（注目ポイント＋ひとこと）で2〜3個程度を目安に積極的に使う。ただし1つの文に2個以上付けない。重大事件・法的問題・訃報・被害者のいる話題では感嘆符とツッコミを使わず、落ち着いた文体に切り替える。
- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」
```

受け入れ: 差分が上記と一致。

### B2. 表記辞書

`config/terminology.json` 新規作成（初期値・確定形）:

```json
{
  "version": 1,
  "preferred_names": [
    {
      "zh": "国家广播电视总局",
      "display": "広電局",
      "first_mention": "広電局（国家广播电视总局）",
      "avoid": ["国家ラジオテレビ総局", "国家ラジオ・テレビ総局", "国家放送テレビ総局", "国家広播電視総局"]
    },
    {
      "zh": "国家电影局",
      "display": "国家電影局",
      "first_mention": "国家電影局（中国の映画主管当局）",
      "avoid": ["国家映画局"]
    }
  ],
  "known_terms": ["微博", "豆瓣", "熱搜", "IP", "OST", "IMAX"],
  "first_gloss_terms": [
    { "term": "偷票房", "gloss": "興行収入のごまかし・横取り" },
    { "term": "排片", "gloss": "上映枠の割り当て" },
    { "term": "暑期档", "gloss": "夏休み興行シーズン" },
    { "term": "备案", "gloss": "制作前の届け出" },
    { "term": "定档", "gloss": "公開日の決定" },
    { "term": "微短剧", "gloss": "1話数分の縦型短尺ドラマ" },
    { "term": "飯圏", "gloss": "中国のファンダム文化" }
  ],
  "always_explain_terms": ["分段密钥", "发行许可证", "纪律审查", "监察调查"]
}
```

`src/terminology.ts` 新規: `loadTerminology()`（読込失敗時は空辞書で続行・警告ログ）、`applyTerminology(summary)`（title_ja / lead / what_happened / why_it_matters / reaction_view / japan_context_note / editor_comment を記事内の出現順に走査し、preferred_names の zh＋avoid 全表記を、記事内最初の1回だけ first_mention、以降 display に決定的置換。first_mention 文字列が既に本文にある場合は二重括弧にしない）、`formatTerminologyForPrompt()`（プロンプト注入用テキスト生成）。適用箇所は summarizeTopic / summarizeArticle が summary を返す直前（台帳経路・単段 fallback 経路の両方）。
受け入れ: ダミー記事の「国家ラジオテレビ総局」「国家广播电视总局」が初出「広電局（国家广播电视总局）」・以降「広電局」になる。

### B3. types.ts 型追加

- `FactLedgerTerm` を `{ term: string; gloss_ja: string; what_is?: string; why_now?: string }` に拡張
- `ClaimCheckRule` に追加: `"fabricated_reaction" | "unverified_speculation" | "template_comment" | "tone_exclamation" | "hedged_verified_fact" | "long_sentence" | "terminology_avoid"`
- `export type ToneMode = "normal" | "sober";`
- `TopicGenerationMeta` に追加: `tone_mode?: ToneMode; comment_stage?: { attempted: boolean; used: boolean; regenerated: boolean; fallback_reason: string; exclamation_count: number };`

### B4. 台帳抽出の改訂（src/factLedger.ts）

buildFactLedgerPrompt を次の確定文面に差し替える（入力トピック・evidence 一覧の付け方は現行どおり）。**この文面は 3a の確定文面を supersede する。一字も変えない**:

```text
あなたは中国エンタメニュースの事実整理AIです。1つのトピックと複数のevidenceから、後工程が日本語記事を書くための「事実台帳」をJSONで作ります。

最重要ルール: 後工程はこの台帳だけを使って記事を書き、台帳に無い情報は一切書けません。evidenceにある重要情報を漏らさず、evidenceに無い情報を混ぜないでください。

claimの分類（type）:
- verified_fact: evidenceに直接書かれている日付・数字・人物・組織・出来事。
- source_analysis: 元媒体による分析・見方・評価・将来予測。source_name（媒体名）を必ず入れる。
- unsupported: evidence中に現れるが根拠が確認できない情報（伝聞、真偽不明の噂など）。記事には使われない。

規則:
- claimのtextは必ず日本語1文で書く。中国語の文をそのまま写さない（人名・作品名などの固有名詞は原文表記のままでよい）。
- claimは1件1文。重要な順に最大20件。
- entities（人物・作品・組織の固有名詞）とnumbers（数字・日付）は原文の表記のまま入れる。claimの文中に出てくる数字・日付・序数（第八届など）は必ずnumbersにも入れる。
- quote_zhには根拠となる原文の該当箇所を30字以内で入れる。
- evidence_refsには根拠のevidence番号（"E1"など）を必ず入れる。
- このトピックの中心にある制度・仕組み・業界用語について、evidenceが「それが何か」「なぜ問題・重要なのか」「どう機能するのか」を説明している場合、その説明を必ずclaimとして拾う。用語の説明はニュースの理解に不可欠な情報として扱う。
- 日本での公開・配信・日本語字幕に関する情報がevidenceに明示されている場合のみ、japan_availabilityのstatusを "verified" にし、detailに内容、evidence_refsに根拠を入れる。evidenceに無ければ status は "not_in_evidence"、detailは空文字。推測で "verified" にしない。日本に関する言及が無いことは「日本未公開」を意味しない。
- terms には、このevidenceの本文に実際に登場する中国エンタメ用語のうち、日本の読者に説明が必要なものだけを入れる（最大8件）。evidenceに登場しない用語を入れない。一般的な用語例からの丸写しをしない。
  - gloss_ja: 短い日本語訳（20字以内）。
  - what_is: その用語が指す仕組み・制度の説明（40字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - why_now: 今回のニュースでその用語がなぜ重要かの説明（60字以内）。evidenceに説明がある場合のみ。無ければ空文字。
  - what_is / why_now を一般知識で補完しない。evidenceに書かれていることだけを使う。
- evidence間で数字・日付・事実が食い違う場合は unresolved に1行で記す。どちらかへ勝手に寄せない。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "topic_key": "<入力値をそのまま>",
  "claims": [{ "id": "C1", "type": "verified_fact", "text": "", "evidence_refs": ["E1"], "source_name": "", "entities": [], "numbers": [], "quote_zh": "" }],
  "terms": [{ "term": "", "gloss_ja": "", "what_is": "", "why_now": "" }],
  "japan_availability": { "status": "not_in_evidence", "detail": "", "evidence_refs": [] },
  "unresolved": []
}
```

normalizeFactLedger の変更: terms の what_is（40字）/ why_now（60字）を切り詰めて取り込む。**term 文字列が evidence の本文（title＋rawContent＋excerpt の連結）に出現しない term を除去する**（決定的・例丸写し対策）。このために normalizeFactLedger へ evidence テキストを渡すようシグネチャを拡張する。
受け入れ: ダミー台帳で例示語のみの term が除去され、evidence に出る term は残る。

### B5. claimCheck 正規化強化・照合先拡大・gate 昇格（src/claimCheck.ts）

1. `normalizeNumberToken` 強化（仕様）:
   - 漢数字（一〜十・百・千・两）を算用数字へ変換（3桁まで。例: 十五→15、两→2、第八→第8）
   - 序数統一: 第N届／第N回／第N期 → 「第N」
   - 回数単位統一: N次／N回／N场／N場 → 「N回」
   - 日付統一: YYYY-MM-DD と YYYY年M月D日（先頭ゼロあり含む）→ 「YYYY年M月D日」（月日の先頭ゼロ除去）
   - 既存の全角→半角・カンマ除去・億/亿統一は維持。万/萬 → 万
2. 照合プール拡大: 台帳側の数字トークンを claim.numbers に加えて claim.text・claim.entities・quote_zh からも抽出する。
3. gate 昇格: number_not_in_ledger のうち、単位が 亿/万/元/%/人/回 のトークン、および年月日を含む完全日付のトークンは severity "gate"。単独の「N年」（期間表現）や単位なし数字は warning のまま。
4. japan_comparison_no_claim の正規表現を実比較に絞る: 「日本」を含む文のうち `/日本(の|と|でも|より|では)/` にマッチし、かつ `/日本語圏/` を含まない文だけを対象にする（warning 維持）。

検算（2026-07-18 データでの期待動作）: 蔡赴朝の日付・郎朗の15回・微短剧の第8回は偽陽性解消（一致）。郎朗の「120億回」は台帳「12亿次」と正規化後も不一致 → gate → 文削除で除去される。Seedance2.0・「ここ2年」は warning 止まり。japan_comparison の3件（日本語圏フレーム）は発火しなくなる。
受け入れ: 上記検算をダミーデータで再現。

### B6. トーンモード判定（新規 src/toneMode.ts）

```ts
export function getToneMode(topic: TopicCandidate, ledger?: FactLedger): ToneMode;
```
topic_key＋event_sentence＋（あれば）台帳 claims の text を連結し、次の正規表現にマッチしたら "sober"、それ以外は "normal":
中文: `违纪|违法|被查|被捕|逮捕|拘留|起诉|判决|诉讼|犯罪|吸毒|嫖娼|偷税|逃税|性侵|家暴|猥亵|去世|离世|逝世|病逝|自杀|遇难|身亡|受害|遇害|事故|灾害|地震|火灾`
和文: `規律違反|審査調査|起訴|判決|訴訟|脱税|性加害|性暴力|死去|死亡|訃報|自殺|被害|事故`
検算: 蔡赴朝 → sober（违纪违法）。功夫女足偷票房 → normal（疑惑段階・法的手続きなし・被害者なし）。
受け入れ: 上記2検算がダミーで通る。

### B7. コメント工程（src/summarizeWithGemini.ts）

1. 執筆プロンプト（buildLedgerWritingPrompt）を次の確定文面に差し替える（返す JSON 雛形・入力トピック・台帳 JSON・violation 追記の付け方は現行どおり。**この文面は 3a の確定文面を supersede する。一字も変えない**）:

```text
あなたは中国エンタメの日本語ニュースメモを書く編集AIです。入力は「事実台帳」だけです。元記事の原文はもう見られません。読者は中国エンタメに関心のある日本語話者で、中国の制度・業界用語の前提知識はありません。

Editorial character policy document (docs/editorial-character.md):
<editorial文書をここに挿入>

Use the document above as the highest-priority editorial policy.

表記辞書（この表記を優先する）:
<terminology注入部: formatTerminologyForPrompt() の出力をここに挿入>

最重要ルール:
- 台帳のclaimsにある情報だけで書く。台帳に無い数字・日付・人物・作品・出来事・背景説明を足さない。
- type: unsupported のclaimは本文に使わない。
- type: source_analysis のclaimを使う文は、必ずsource_nameの媒体名を主語または出典として明示し、断定しない（「〜と見ています」「〜と報じています」）。業界全体の事実のように書かない。
- 日本での公開・配信・字幕は、japan_availability.status が "verified" の場合だけ、detailの範囲で書く。"not_in_evidence" の場合は「日本では未公開」と書かず、触れないか「日本での公開情報は今回の情報源からは確認できていない」とする。
- 予測を「確実」と断定しない。

用語の扱い:
- 表記辞書に優先表記がある語は必ずその表記を使う。
- 表記辞書の既知語は説明なしでそのまま使ってよい。
- このニュースの中心にある用語（termsのうちwhat_is/why_nowがあるもの、および表記辞書の「毎回説明する語」）は、単なる括弧書きの訳語で済ませず、「それが何か」「今回なぜ重要か」が本文の流れの中で分かるように、claimsとtermsの説明を使って書く。
- 中心の用語なのに台帳に説明材料が無い場合は、一般知識で補完せず、「〜の詳しい仕組みは今回の情報源では説明されていない」と明示するか、その用語を使わずに書く。
- 周辺的な用語は「用語（gloss_ja）」の括弧書きだけでよい。
- unresolvedにある食い違いは、どちらかへ寄せず「E1では○○、E2では△△」と併記するか、触れない。

文体:
- lead / what_happened / reaction_view / japan_context_note は通常の報道文体。ただし一文は60字以内を目安に短く切る。
- why_it_matters（見出し「ビンタンの注目ポイント」）と editor_comment（見出し「ビンタンからのひとこと」）は、docs/editorial-character.md の口調規定に従いビンタンの声で書く。

構成ルール:
- lead: 2〜3行。トピック全体として何が起きたか。
- what_happened: 150〜250字。verified_fact claimだけで出来事・数字・日付・関係者を整理。
- why_it_matters: 100〜200字。ビンタンの注目ポイント。最初の1文で「読者にとって要するに何が起きたか」を平易に言い、その後に「何が確認できれば評価が変わるか」「今後追うべき数字・発表」。what_happenedの言い換えをしない。
- reaction_view: SNS由来または複数媒体のclaimがある場合のみ100〜200字。無ければ空文字。
- japan_context_note: 日本語圏で見えにくい文脈のclaimがある場合だけ。無ければ空文字。
- editor_comment: 1〜2文の短いひとこと。why_it_mattersと同じ内容を繰り返さない。
- 本文合計はおおむね400〜700字。
- claim_refs に、各セクションで根拠にしたclaimのidを入れる（例: {"what_happened": ["C1","C2"], ...}）。
- 必ずJSONだけを返す。
```

2. 新規 `buildBingtangCommentPrompt(topic, ledger, summary, toneMode, violations?)` を追加（確定文面・一字も変えない。末尾に入力として topic_key / event_sentence / tone_mode / 完成本文（lead・what_happened・reaction_view・japan_context_note）/ 事実台帳 JSON を付け、violations がある場合は既存と同形式の書き直し指示を付ける）:

```text
あなたはこのサイトの秘書キャラクター「冰糖（ビンタン）」として、完成した記事本文に付けるコメントを書くAIです。

Editorial character policy document (docs/editorial-character.md):
<editorial文書をここに挿入>

Use the document above as the highest-priority editorial policy.

あなたの仕事:
- 記事本文はすでに完成しています。あなたが書くのは「ビンタンの注目ポイント」（why_it_matters）と「ビンタンからのひとこと」（editor_comment）の2つだけです。
- コメント欄は、本文を難しく言い換える場所ではありません。難しい中国エンタメの事情を、読者に明るく噛み砕いて渡す場所です。
- 本文と事実台帳にある情報だけを使います。新しい数字・人物名・作品名・出来事を足しません。

why_it_matters（ビンタンの注目ポイント）の書き方:
- 最初の1文は、読者にとって「要するに何が起きているのか」を、前提知識ゼロで分かる平易な言葉で言い切る。「要するに、〜ということです！」の形を使ってよい（毎回でなくてよい）。
- そのあとに、このニュースのどこが面白いか・引っかかるか、何が確認できれば評価が変わるか、今後追うべき数字・発表を書く。
- 本文に難しい制度・用語（台帳のtermsにwhat_is/why_nowがあるもの）が出てくる記事では、その仕組みの噛み砕き説明をここでやる。台帳のterms・claimsにある説明だけを使い、一般知識で補完しない。
- 抽象的な分析だけで終わらせない。具体的な数字・出来事・確認ポイントを挙げる。
- 100〜250字。一文は50字以内を目安に短く切る。

editor_comment（ビンタンからのひとこと）の書き方:
- 1〜2文。why_it_mattersと同じ内容を繰り返さない。
- 自分（ビンタン）が次に何を見るか、どこが気になるかを軽く言って締める。

口調（トーンモード: <tone_mode>）:
<tone_modeがnormalの場合、次の3行を挿入>
- 明るく、少し前のめりな、話し言葉に近い「です・ます調」。
- 使ってよい語尾の例: 「〜ですね！」「〜なんです！」「〜ですよ〜！」「〜ですって！」「〜ましたね〜！」「要するに、〜ということです！」
- 「！」は2つのコメント欄あわせて2〜3個使う。ただし1つの文に2個以上付けない。
<tone_modeがsoberの場合、次の1行を挿入>
- この話題は重大事件・法的問題・訃報・被害者のいる話題です。「！」を一切使わず、落ち着いた「です・ます調」で書く。軽いツッコミや明るい言い回しを使わない。確認できた事実と、まだ分かっていないことの境界をはっきり言う。

禁止事項:
- 「〜みたいです」「〜のようです」は伝聞・噂・未確認情報にだけ使う。台帳のverified_factで確認できている事実に付けない。
- SNSや反応のevidenceが無いのに「ファンからは好意的な反応が予想されます」のような反応の予想・想像を書かない。
- 「初共演ではないでしょうか」のような、台帳で確認できない推測を書かない。
- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」「目が離せません」
- 実在の人物・ファンをからかわない。ツッコミの対象は状況・数字・自分自身のみ。

必ず次のJSONだけを返す:
{
  "why_it_matters": "",
  "editor_comment": "",
  "claim_refs_why_it_matters": []
}
```

3. summarizeTopic のフロー拡張（台帳経路で claim_check 通過後）: `process.env.COMMENT_STAGE !== "false"` かつ budget 残ありのとき、`getToneMode` → コメント生成（LLM 1回）→ B8 の runCommentCheck → gate 違反ありならコメントのみ再生成1回（violations をプロンプトに付記）→ まだ違反なら違反文削除 → why_it_matters が空になったら執筆段コメントへ差し戻し（fallback_reason 記録）→ 感嘆符の決定的サニタイズ → summary の why_it_matters / editor_comment / claim_refs.why_it_matters を置換。コメント工程の LLM 失敗・JSON 失敗・budget 枯渇は throw せず執筆段コメントを使用し fallback_reason を記録。meta.tone_mode / meta.comment_stage を設定。

### B8. コメント検査（src/claimCheck.ts に runCommentCheck 追加）

```ts
export function runCommentCheck(whyItMatters: string, editorComment: string, ledger: FactLedger, topic: TopicCandidate, toneMode: ToneMode): ClaimCheckViolation[];
export function sanitizeExclamations(text: string, toneMode: ToneMode): string;
```
検査ルール（コメント2欄のみ対象）:
- fabricated_reaction（gate）: `/反応が(予想|期待)され|好意的な反応|ファンから.{0,12}(反応|声)が(集ま|上が|出)/` にマッチし、かつ topic.source_mix.sns + topic.source_mix.rumor === 0
- unverified_speculation（gate）: `/ではないでしょうか/`。`/かもしれません/` は warning
- template_comment（gate）: `/業界全体に影響を与える可能性|透明性向上につながる可能性|今後の動向(に|を)?(注目|注視|追|見守)|評価のポイントになりそう|新たな指標になるか|目が離せ(ない|ません)|注目したいところ|注目が集ま(りそう|る)/`
- tone_exclamation: sober かつ「！」>0 → gate ／ normal かつ（「！」=0 または >3 または1文に2個以上）→ warning
- long_sentence（warning）: 90字超の文
- hedged_verified_fact（warning）: `みたい|のようです` を含み、topic に sns/rumor evidence が無く、台帳に unsupported claim が無い

sanitizeExclamations（純関数）: sober → 全「！」「!」を「。」に置換 ／ normal → 1文内の2個目以降を「。」に置換し、全体で4個目以降を「。」に置換。
受け入れ: sober＋！→gate、「反応が予想され」→gate、「今後の動向に注目」→gate、sanitize の各ケースがダミーで通る。

### B9. 情報完全性ゲート（新規 src/completenessGate.ts + src/index.ts 接続）

```ts
export function evaluateTopicInformationCompleteness(topic: TopicCandidate): { complete: boolean; reasons: string[] };
```
判定条件:
1. `no_subject_entity`: main_entities の people・works・events がすべて空で、organizations から evidence_articles の source_name と一致するものを除くと空
2. `low_seed_confidence`: seed_source === "llm" かつ seed_confidence < 0.5（実測根拠: 正常候補の最低値 0.7、ジャンクは 0.2〜0.4）
3. `title_echo_event`: event_sentence が空、または `/という記事を掲載/` にマッチ、または単一 evidence で event_sentence が title_hint をそのまま含む
4. `thin_unknown`: topic_type === "unknown" かつ source_count === 1 かつ evidence の key_points 合計 40字未満

発火規則: seed_source === "llm" の候補は 1〜4 のいずれかで除外。seed_source === "regex_fallback" の候補は 1 のみで除外（LLM seed 全滅の劣化日に confidence 一律 0.35 で全滅するのを防ぐ）。`process.env.INFO_COMPLETENESS_GATE === "false"` で全体を無効化。
接続: src/index.ts の selectTopicsForAi 内、freshness チェック通過後・eligible 追加前に評価。不合格は `dropped.push({ topic, reason: "information_incomplete:" + reasons.join("+") })`。eligible に入らないため final_fill・backfill からも自動的に除外される。10本未満はそのまま許容（埋め直さない）。
trace: selection_trace に `information_gate: { enabled, evaluated, excluded, excluded_topics: [{ topic_key, reasons }] }` を追加。
検算（2026-07-18 データ）: 大哥（1・2・3該当）・田园农场风・爹地每次拍完照妈咪就这样が除外。選定済みの他9件は通過（郎朗は unknown だが conf 0.9・entities 有で通過。电视剧发行许可は organizations が出典と同名でも events が非空で通過）。最終出力は9本になる。
受け入れ: ダミー検算＋ローカル trace に information_gate が出る。

### B10. trace 拡張・budget 60

- src/llmCallBudget.ts: 既定値 45→60
- src/selectionTrace.ts: claim_check 配列の各要素に tone_mode / comment_stage を追加、information_gate を追加
- 既存の診断項目を壊さない（AGENTS.md 設計原則6）

### B11. 品質レポート（新規 src/qualityReport.ts + package.json）

`npm run report:quality` で最新の output/articles_YYYY-MM-DD.json と selection_trace を読み、LLM なしで出力: 記事ごとの（tone_mode / コメント欄の「！」数 / 定型句マッチ / avoid 表記残存 / 90字超文数 / みたい出現）と、information_gate の除外一覧、budget 使用量。受け入れ基準の機械確認に使う。

### B12. 検証 → roadmap 更新 → コミット

## 5. graceful fallback 一覧

| 障害 | 挙動 |
|---|---|
| コメント工程の LLM 失敗・JSON 切断 | 執筆段のコメントをそのまま使用。trace に fallback_reason |
| コメント再生成後も gate 違反 | 違反文削除 → why_it_matters が空なら執筆段コメントへ差し戻し |
| budget 枯渇（コメント工程前） | コメント工程スキップ・執筆段コメント使用（新規に throw しない） |
| 台帳抽出失敗 | 既存どおり単段 fallback（コメント工程・claim_check なし） |
| terminology.json 読込失敗 | 置換スキップ・警告ログ（生成は止めない） |
| ゲートで候補不足 | 10本未満で出力（埋めない） |
| LLM seed 全滅（regex fallback 日） | ゲートは no_subject_entity のみ適用 |

## 6. warning→gate 昇格表（2026-07-18 実測が根拠）

| ルール | 3a | 3b | 根拠（2026-07-18 実測） |
|---|---|---|---|
| number_not_in_ledger（金額・完全日付・人数・回数） | warning | **gate**（正規化強化後） | 真陽性1件（郎朗120億回 vs 台帳12亿次）が公開された。偽陽性9件は正規化不足が原因で解消可能 |
| number_not_in_ledger（単位なし・年単独） | warning | warning | Seedance2.0／ここ2年 型の偽陽性が残る |
| entity_not_in_ledger | warning | warning（照合先に claim.text 追加） | 発火なし。誤爆リスクの方が高い |
| japan_comparison_no_claim | warning | warning（実比較に絞る） | 3件全て偽陽性（「日本語圏では見えにくい」フレーム誤認） |
| unsupported_generalization | warning | warning | 発火なし。観察継続 |
| generic_comment | warning | 廃止 → template_comment（コメント工程 gate）に置換 | 40字未満条件で一度も発火せず、定型句は8/10記事に出現 |
| fabricated_reaction（新規） | — | gate（コメント工程） | 袁娅維「好意的な反応が予想されます」が公開された |
| unverified_speculation（新規） | — | gate（コメント工程） | 群星「初共演ではないでしょうか」が公開された |
| template_comment（新規） | — | gate（コメント工程） | 「今後の動向に注目」型が8/10記事 |
| tone_exclamation（新規） | — | sober: gate ／ normal: warning＋再生成1回 | 全記事で「！」0個 |
| hedged_verified_fact（新規） | — | warning | 照合が近似のため |
| terminology_avoid（新規） | — | warning（置換は決定的に実施） | 置換後の検算用 |

## 7. Before/After（3件・完成形）

### (1) 功夫女足偷票房

Before（2026-07-18 実出力の注目ポイント・ひとこと を引用）:
> 『功夫女足』は周星馳にとって7年ぶりの新作で、（中略）特に、配給側が分割キー（分段密钥）という技術的対策を導入した点は、業界全体の透明性向上につながる可能性があります。今後は、この疑惑が実際に興行収入にどの程度影響を与えるか、また業界の是正措置がどの程度効果を発揮するかが注目ポイントです。
> 周星馳監督が自らSNSで疑問を投げかけたのは、かなり異例の動きですね。この問題が単なる噂で終わるのか、業界の構造的な課題を浮き彫りにするのか、今後の動向を追いたいと思います。

After（完成形。「！」3個・1文1個以下・normal トーン）:

ビンタンの注目ポイント:
> 要するに、『功夫女足』は大ヒット中なのに、その売上が正しくカウントされていない疑いが出ている、ということです！発端は、窓口で買ったチケットが白紙だったという観客の報告でした。正規の発券システムを通らないチケットは、売上が作品の興行収入に計上されず、配給側への分配も狂うおそれがあります。だから白紙や手書きのチケットは「偷票房（興行収入のごまかし）」の疑いにつながるんです。対策として配給側が入れた「分段密钥」は、上映用のデジタルキーを短い期間ごとに分けて渡す仕組みで、問題のある映画館には次のキーを渡さない、つまり上映を止められるのがポイントですね！ただし映画館側は「新しいロール紙が湿って印字できなかった正規券」と説明していて、不正はまだ確定していません。

ビンタンからのひとこと:
> 周星馳監督本人がSNSに疑問符3つで反応したのは、かなり異例ですって！わたしは次の週末の興収と、通報窓口からの続報をチェックしますね。

注記: 「売上が計上されず配給側に分配されない」の因果説明は、台帳の terms.why_now／claims（例: C17 界面新闻の分析）に材料がある場合の完成形。材料が台帳に無い場合の縮退形は「白紙チケットがなぜ問題になるのかは、今回の情報源では仕組みまでは説明されていません。ただ、正規のシステムを通ったチケットかどうかが争点です。」とし、一般知識で補完しない。

### (2) 元広電局トップ・蔡赴朝氏

Before（実出力）:
> 見出し・本文で「国家ラジオテレビ総局」表記。注目ポイント「業界全体に影響を与える可能性があります。今後の動向として、調査の進展や、関連する業界規制の変化、さらなる関係者の動きに注目したいですね。」（sober であるべき話題に「〜ですね」の軽い定型句）

After（完成形。sober トーン・「！」0個・広電局表記。lead / what_happened は報道文体のまま表記のみ「広電局（国家广播电视总局）」に）:

ビンタンの注目ポイント:
> 要するに、中国のテレビとネット動画をまとめて管轄する役所「広電局（国家广播电视总局）」の元トップが、重大な規律違反・違法の疑いで正式な調査を受けることになった、という話です。「審査調査」は、党の規律違反を調べる紀律審査と、国家の監察機関による監察調査をあわせた呼び方で、幹部に対する正式な調査手続きです。エンタメの許認可を長く握ってきた組織のトップ経験者が対象になった点が今回の重さです。今後は調査の進展と、広電局の政策・人事に変化が出るかどうかが確認ポイントです。

ビンタンからのひとこと:
> 現時点で出ているのは公式発表だけで、容疑の中身はまだ分かりません。続報を落ち着いて追います。

### (3) 「大哥」記事

Before: seed_confidence 0.2・topic_type unknown・主語エンティティなしのまま final_fill で採用され、「大哥」が誰か不明の記事が公開された。

After: 生成前に情報完全性ゲートで除外。LLM 呼び出しは発生しない。trace には次が残る:

```json
{ "topic_key": "大哥发视频没有自己画面", "reason": "information_incomplete:no_subject_entity+low_seed_confidence+title_echo_event" }
```

information_gate.excluded_topics には同型の「田园农场风」「爹地每次拍完照妈咪就这样」も並び、2026-07-18 相当の日の最終出力は9本になる（10本未満を許容）。

## 8. 受け入れ基準

1. 通常記事のビンタンコメント欄（注目ポイント＋ひとこと合計）に「！」が1〜3個（目標2〜3個）、1文に2個以上ない
2. sober 判定記事（重大事件・法的問題・訃報）では「！」が0個
3. 偷票房型の記事で、中心用語の「それが何か」「今回なぜ重要か」が本文またはコメントで説明される（分段密钥・白紙チケットの説明文が存在する）。台帳に材料が無い場合は「今回の情報源では説明されていない」と明示される
4. 国家广播电视总局が「広電局」表記になる（初出は「広電局（国家广播电视总局）」）。「国家ラジオテレビ総局」の出現0
5. 大哥型候補が information_incomplete で生成前に除外され、trace に理由が残る
6. 品質を満たす候補が足りない日は最終出力が10本未満のまま完走する
7. 台帳外の金額・完全日付が gate で除去される（郎朗120億回型が公開されない）。台帳外の人物・日本比較は warning で trace に残る
8. 確認済み事実に「みたい」「のようです」が付かない（hedged_verified_fact warning 0 を目標、実出力で手動確認）
9. 「今後の動向に注目」だけの汎用コメントが残らない（template_comment 検出0）
10. 維持ライン: 官庁比率 ≦50%（基準値 20.2%）・媒体 fresh >0（基準値 34）・複数ソース topic ≧1・ledger_used 8割以上・llm_call_budget.used ≦60
11. `COMMENT_STAGE=false` で 3a 相当のコメント生成に戻り、`INFO_COMPLETENESS_GATE=false` でゲートが無効化される

## 9. 検証手順

1. 各実装ステップ後に `npm run check`
2. ローカルダミー検証（scratchpad の一時スクリプト・コミットしない）: ①正規化（十五次↔15回、2026-07-15↔2026年7月15日、第八届↔第8回、120億回 vs 12亿次→gate）②completeness gate（大哥候補 JSON→除外理由3つ、郎朗候補→通過）③comment check（sober＋！→gate、「反応が予想され」→gate、「今後の動向に注目」→gate、sanitize）④terminology（国家ラジオテレビ総局→広電局置換・初出括弧）⑤toneMode（蔡赴朝→sober、偷票房→normal）
3. `npm run start`（ローカル・APIキーなし）: trace に information_gate / comment_stage が出て、既存診断（候補数・官庁比率・媒体 fresh・複数ソース topic）が壊れていないこと
4. push → Actions(deepseek) 実測: 受け入れ基準 1〜10 を確認し、2026-07-18 実測（官庁 20.2%・媒体 fresh 34・複数ソース 1・ledger 10/10・budget 24）と比較して後退がないこと
5. `npm run report:quality` で「！」数・定型句・avoid 表記・除外理由を機械確認
6. roadmap 更新（3b ✅ ＋実測値1行）→ コミット

## 10. やらないこと

- analysis_feature の解禁（3c。F5 の skip は維持）
- Phase 4 サイト UI の変更（build.ts の閉じタグ typo は別タスクで対応中）
- 追加検索による用語補完（2-6 / 将来）
- テストフレームワーク導入・HTTP 共通化リファクタ
- 事実本文（lead / what_happened / reaction_view / japan_context_note）の安全規則の緩和
