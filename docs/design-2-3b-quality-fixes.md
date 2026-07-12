# 設計: 2-3b 品質修正パッチ（Fable 原因分析 2026-07-12）

2-3 実装後の Actions 実行（2026-07-12）で出た品質問題の原因分析と修正指示。
**この文書に沿って Codex が実装する。** 元データ: selection_trace / topic_candidates 2026-07-12。

## 原因分析サマリー

| 症状 | 根本原因 |
|---|---|
| 映画ばかり（6本中5本） | ①選定8本中ドラマ2本が AI 段階で消えたが補充がない ②映画 topic がカテゴリ誤判定で芸能/業界枠を占有 ③supply が映画媒体に厚くSNSゼロ |
| 北京管乐展演が出た | 官製文化イベント（展演/文联主催）への減点シグナルが無い。音楽の大衆性判定も編集方針も未定義 |
| 分析記事（極限定档）が出た | column キーワード検出をタイトルがすり抜け。summarizeTopic プロンプトに業界分析の skip 指示が弱い |
| （未指摘・重大）topic seed が全件 regex fallback | DeepSeek 応答 JSON が長さ超過で切断（115記事を1バッチ）。**2-1 の LLM 経路は本番未成功** |
| （未指摘）expansion 9/9 http_error | 公開 rsshub.app が Actions からも全滅。2-5 の発動条件成立 |
| （未指摘）trace の final_output が全フィールド None | topic 経路の trace 構築バグ。post-AI 除外理由も trace に残らない |

ユーザー決定（2026-07-12）: 音楽は「低優先度」方式（除外ではない）／ 検索APIは Serper を今導入（2-5 前倒し）。

## 修正項目（この順で実装）

### F1. topic seed 抽出のバッチ分割（src/topicSeeds.ts）— 最重要

- 1回の LLM 呼び出しを **25記事まで** に分割し、チャンクごとに順次呼び出す
- DeepSeek には `max_tokens: 8000`、Gemini には `maxOutputTokens: 8192` を明示
- チャンク単位の失敗はそのチャンクだけ regex fallback（全体を巻き込まない）
- 抽出結果 meta に `chunk_count` / `failed_chunk_count` を追加
- **受け入れ基準**: Actions 実行で `seed_source: llm` が 8割以上になる

### F2. AI 段階で消えた topic の補充（backfill）と trace 可視化（src/index.ts, selectionTrace.ts）

- summarizeTopic が AI エラー / post-AI 除外になったら、**同カテゴリの次点 topic を補充**して
  再度 AI 処理する（補充は最大 `maxArticles` に達するまで。無限ループ防止に補充回数上限 = maxArticles）
- `topic_selection` trace に `failed: [{topic_key, stage: "ai_error"|"post_ai_exclude", reason}]` と
  `backfilled: [topic_key]` を追加
- final_output trace の title_ja / badge が None になるバグを修正（topic 経路で summary を渡す）
- **受け入れ基準**: AI 段階で topic が消えても最終出力本数が維持され、消えた理由が trace で追える

### F3. カテゴリ判定の修正（src/classifyArticle.ts getFeedCategory）

- 判定順を「ドラマ・配信 → **映画** → 芸能・俳優 → 業界動向」に変更
  （現在は芸能・業界が先に食うため、三国第一部→芸能・俳優、功夫女足→業界動向になった）
- **受け入れ基準**: 映画作品の topic（三国第一部型・功夫女足型）が feedCategory=映画 になり、
  ドラマ・芸能・業界枠を占有しない

### F4. 官製文化イベント低優先度化 + 音楽の大衆性判定（classifyArticle.ts, topicCandidates.ts）

- 官製文化イベント判定: `/展演|文联|文化馆|群艺馆|交响|管乐|民乐|合唱|戏曲|京剧|越剧|昆曲|书法|美术展/`
- ポップスシグナル: `/歌手|演唱会|巡演|专辑|单曲|音综|打歌|榜单|音乐节|MV/`
- ルール: 官製文化イベント判定に一致し、**ポップスシグナルが無い**記事は `isLowPriority = true`
- topic スコア: 該当 topic は上限 55（SNS単独ガードと同じ仕組みに相乗り）
- editorial-character.md への方針追記は本コミットで実施済み（音楽=大衆ポップス軸）。プロンプトは
  editorial 文書を読み込むため自動で追従する
- **受け入れ基準**: 管乐展演型の記事が publish_priority low になり、通常枠に出ない

### F5. 分析記事の skip 強化（src/summarizeWithGemini.ts の topic プロンプト）

buildTopicPrompt の禁止事項ブロックに以下をそのまま追加する（文言確定済み・変更しない）:

```text
- 代表evidenceが「媒体による業界分析・特集・深度取材記事」（ある現象を複数の関係者取材や
  データでまとめた論考。タイトルが「〜现象」「〜背后」「谁的〜」「〜们」型の記事を含む）の場合、
  そのトピックはニュースイベントとして書かず、article_type を column_opinion にして
  skip_reason に "media_analysis_feature" を入れる。
  ただし、分析記事が「別の具体的な出来事」の evidence の1つとして使われている場合は、
  出来事側を主役にして反応・見られ方の材料として使ってよい。
```

- **受け入れ基準**: 極限定档型の特集記事が単独 topic として出力されない
  （post-AI 除外に落ち、F2 の backfill で別 topic に置き換わる）

### F6. Serper 検索 fetcher の追加（src/expandSources.ts）— 2-5 前倒し

- 新 fetcher `serper-search`: `POST https://api.serper.dev/search`
  ヘッダ `X-API-KEY: ${SERPER_API_KEY}`、ボディ `{ "q": query, "gl": "cn", "hl": "zh-cn", "num": 10 }`
- organic 結果 → evidence 変換。source_type はドメインで判定:
  `weibo.com→sns / douban.com→data / maoyan.com,piaofang→data / bilibili.com→sns / それ以外→media_report`
- 呼び出し順: RSSHub ルートを先に試し、**topic の全 RSSHub ルートが失敗した場合のみ** Serper を叩く
  （無料枠 2,500 クエリの節約。1実行 = 上位3 topic × 1クエリ = 最大3クエリ）
- `SERPER_API_KEY` 未設定なら skip（graceful fallback、trace に `not_configured`）
- `.env.example` に `SERPER_API_KEY=` を追記。GitHub Secrets にも登録が必要（ユーザー作業）
- **受け入れ基準**: Actions 実行で expansion の success > 0、source_count>=2 の topic が実データで発生
- 既存 evidence 一致判定（isUsefulEvidence のトークン一致）は Serper 結果にもそのまま適用

### F8. カテゴリ上限の再設計（src/index.ts, classifyArticle.ts, types.ts）— ユーザー指示 2026-07-12

現行の「映画3＋海外中国映画祭1」は実質映画系に4席を予約しており映画偏重の一因。以下に変更する。

- `CATEGORY_LIMITS` を **映画2 / ドラマ・配信2 / 芸能・俳優2 / 業界動向2 / 公式発表2** に変更
- **「海外中国映画祭・文化交流」カテゴリを廃止**:
  `getFeedCategory` の海外映画祭早期returnを削除し、該当記事は自然分類（映画/公式発表など）に落とす。
  `FeedCategory` 型からも値を削除（isLowPriority の海外映画祭系減点ロジックは残す）
- **「その他」の予約席を廃止**: 選定ローテーションは上記5カテゴリのみで回す
- **ポップス系を「芸能・俳優」へ**: `getFeedCategory` の芸能・俳優判定に
  `歌手|演唱会|巡演|专辑|单曲|音综|打歌|MV|音乐节` を追加
  （「その他」廃止で大衆ポップスの席が消えるのを防ぐ。F4 の官製文化イベント低優先度と併用）
- **最終補充パス**: 5カテゴリの周回で `maxTopics` に届かない場合のみ、
  残りの適格 topic（その他カテゴリ含む）からスコア順に補充する
  （ソース上限・SNS単独上限・low priority 上限は補充時も維持。trace 理由は `final_fill`）
- **受け入れ基準**: 通常日で映画系（映画+旧海外映画祭相当）が最終出力の過半を占めない。
  候補が薄い日でも出力本数が極端に減らない（最終補充パスが動く）

### F7. supply の薄い所を補強（config/sources.json）— 軽微

- ドラマ・芸能系の RSS 候補を1つ追加検証: 新京报は現在エンタメ全般で機能しているため、
  当面は F1〜F6 の効果を見る。**このタスクでは新ソース追加はしない**（変更を小さく保つ）

## 検証手順

1. `npm run check` → `npm run start`（ローカル、regex fallback + Serper キーなし経路の確認）
2. Actions(deepseek) 実行:
   - seed_source: llm ≥ 80%（F1）
   - 最終出力の映画系比率が下がり、ドラマ・芸能系が残る（F2+F3）
   - 管乐展演型・分析記事型が出力に無い（F4+F5）
   - SERPER_API_KEY 設定後: expansion success > 0（F6）
3. roadmap 更新（2-3b ✅ + 実測値、2-5 は F6 実施済みとして更新）→ コミット

## やらないこと

- 記事単位 newsworthinessScore の再設計（Phase 2 完了レビューで判断）
- 新ソースの追加（F7 の通り保留）
- 日本語圏可視性の実測（2-6。Serper 導入で技術的には可能になるが、別タスクとして扱う）
