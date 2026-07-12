# 設計: 2-3c hotfix（Fable 検証 2026-07-12）

2-3b 後の Actions 実行で確認した受け入れ漏れ・実装不具合の修正指示。
**この文書に沿って Codex が実装する。** 全項目、Fable がコード上で根本原因を確認済み。

内容ブラッシュアップ（Phase 3、`docs/design-phase3-content-pipeline.md`）の前に本 hotfix を閉じる。

## 症状と根本原因

| 症状 | 根本原因（確認済みの箇所） |
|---|---|
| 事前スコア low の `北京管乐展演` が LLM 後に medium へ戻り backfill で採用 | ① `normalizePublishPriority`（summarizeWithGemini.ts）が LLM 出力をそのまま採用し、事前 priority へのクランプが無い ② backfill 候補（index.ts `selectTopicsForAi` 末尾）はスコア順のみで、`enqueueTopicBackfill` もカテゴリ一致しか見ない（low priority ガードが本選定パスにしか無い） |
| `微短剧之夜` など7 topic が理由 `unknown` で post-AI 除外 | LLM が規定外の article_type を返すと `normalizeArticleType` が `"unknown"` に落とし、代表記事が fresh-unknown エンタメ候補（articleType 未分類のまま適格になる経路）だと継承でも `"unknown"` のまま → `isPublishableType` で除外、理由 = `skip_reason \|\| article_type` = `"unknown"` |
| 公式ソース2本で URL 欠落（Markdown でリンクにならない） | `mergeTopicInternalMetadata` の requestedSources フィルタが `!source.url` の LLM 出力（名前のみ）を受理し、renderMarkdown は URL なしをプレーンテキスト描画 |
| Serper 全3回 `not_configured` | `SERPER_API_KEY` が GitHub Secrets 未登録（コードは実装済み） |

## 修正項目（この順で実装）

### H1. publish_priority を事前判定へクランプ（src/summarizeWithGemini.ts）

- `mergeTopicInternalMetadata` に追加: `topic.publish_priority === "low"` の場合、
  LLM 出力にかかわらず `publish_priority: "low"` を強制する（low 以外は LLM 出力を尊重）
- 記事経路の `mergeInternalMetadata` にも同様に追加: `article.isLowPriority === true` なら low を強制
- **受け入れ基準**: 事前 low の topic（管乐展演型）が最終出力で priority medium/high にならない

### H2. backfill の low priority ガード（src/index.ts）

- `enqueueTopicBackfill` の候補探索を2段階にする:
  1. まず同カテゴリで `representative.isLowPriority === false` の候補を探す
  2. 無い場合のみ low 候補を許可。ただし現在の選定済み+backfill 済みの
     low priority 件数が `MAX_LOW_PRIORITY_ARTICLES` 未満のときだけ
- low 件数は「`topicSelection.selected` のうち representative.isLowPriority の数」を
  backfill 採用のたびに加算して追跡する
- 上限で見送った low 候補は dropped にせず候補のまま残す（後続 backfill で非 low が尽きた際の再評価対象）
- **受け入れ基準**: backfill が low priority topic を非 low 候補より先に採用しない。
  low の採用は `MAX_LOW_PRIORITY_ARTICLES` の範囲内に収まる

### H3. post-AI unknown 除外の修正（src/index.ts）

- 生成ループの `!isPublishableType(summary.article_type)` 判定の前に、topic 経路のみ次の救済を入れる:
  - `summary.article_type === "unknown"` かつ `summary.skip_reason` が空の場合、除外しない。
    article_type を次の優先順で補正して publish する:
    ① 代表記事の `articleType` が publishable ならそれ
    ② `topic.topic_type` からのマッピング（`gossip_rumor→gossip_rumor` / `box_office→data_report` /
       `policy→official_announcement` / それ以外→`news_event`）
- `skip_reason` が入っている場合は従来どおり除外（LLM の意図的 skip は尊重する）
- 除外時の trace/postAiExclusions の reason に生の `"unknown"` を残さない:
  skip_reason が空で除外に至るケースは `article_type_unknown_llm` と記録する
  （AGENTS.md 設計原則6: 新しい除外理由は必ず trace に理由を残す）
- **受け入れ基準**: 事前適格だった topic が理由 `unknown` で消えない。
  post-AI 除外の reason はすべて識別可能な値になる

### H4. source_list URL の内部メタデータからの復元（src/summarizeWithGemini.ts）

- `mergeTopicInternalMetadata` で sourceList 確定後、各エントリの url を
  `availableSources`（`dedupeEvidenceSources` の結果）から名前一致で再注入する:
  `url: source.url || availableSources.find((a) => a.name === source.name)?.url`
- `related_sources` は再注入後の sourceList を使う（現状同一参照なので自然に反映されることを確認）
- **受け入れ基準**: 内部 evidence に URL がある全ソースが Markdown でリンクになる
  （LLM が URL を省略しても欠落しない）

### H5. Serper 実運用確認（ユーザー作業 + Actions 実測）

- ユーザー作業: Serper.dev の API キーを GitHub Secrets `SERPER_API_KEY` へ登録
- コード変更なし。H1〜H4 のコミット後の Actions 実行でまとめて確認する
- **受け入れ基準**: Actions の selection_trace で expansion success > 0、
  実データで source_count>=2 の topic が発生する

## 検証手順

1. `npm run check`
2. `npm run start`（ローカル）: selection_trace で
   - post-AI 除外理由に `unknown` が無い（H3）
   - backfill 採用 topic に事前 low が混ざる場合、非 low 候補枯渇 + 上限内であること（H2）
   - AI 失敗経路（ローカルは Gemini 不達）でも最終本数が維持される
3. 変更前後で trace/audit 比較: 官庁比率 ≦ 50% / 媒体 fresh > 0 / 複数ソース topic 数が後退しないこと
4. push → Actions(deepseek) 実行:
   - 管乐展演型が priority low のまま（H1）、通常枠・backfill どちらにも medium で出ない（H2）
   - 出力 Markdown の全ソースにリンク URL（H4）
   - expansion success > 0（H5、キー登録後）
5. roadmap 更新（2-3c ✅ + 実測値1行）→ コミット

## やらないこと

- 事実台帳・秘書コメント分離・主張検査（Phase 3。`docs/design-phase3-content-pipeline.md` 参照）
- analysis_feature の解禁（Phase 3c まで現行 F5 の skip を維持する）
- プロンプト本文の変更（H1〜H4 はすべて後処理・選定ロジックの修正で完結する）
