# china-ent-news エージェント向けガイド

中国語圏エンタメの「現地温度」と日本語圏とのズレを拾うニュース収集・生成パイプライン。
単なる公式ニュースの翻訳・要約サイトではない。編集方針の正本は `docs/editorial-character.md`。

**作業を始める前に必ず `docs/roadmap.md` を読むこと。**
フェーズ状況・次のタスク・受け入れ基準・モデル振り分け指針がそこにある。

## パイプライン構造

```
fetchAllSources (config/sources.json の固定ソース, HTML/RSS)
  + fetchHotSearchArticles (微博热搜 via RSSHub, graceful fallback)
  → enrichMissingDateMetadata (日付補完)
  → dedupeArticles (URL正規化 + タイトル類似)
  → classifyArticle (articleType / topicKey / スコア付与)
  → mergeTopicDuplicates (topicKey 一致でソース統合)
  → buildTopicCandidates (topic層。診断 + スコアリング)
  → 記事単位で選定 (freshness gate → カテゴリ/ソース上限)
  → LLM 要約 (summarizeArticle) → renderMarkdown
```

Phase 2 で選定単位を記事 → topic に切り替える予定（roadmap 2-3）。

## ファイルマップ

| ファイル | 役割 |
|---|---|
| `src/index.ts` | メインパイプライン、選定ロジック、selection trace |
| `src/fetchSources.ts` | ソース取得、URL/キーワードフィルタ、日付抽出 |
| `src/fetchHotSearch.ts` | 微博热搜の生成側 fetcher（RSSHub、graceful fallback） |
| `src/classifyArticle.ts` | articleType / feedCategory / newsworthinessScore |
| `src/topicKey.ts` | topicKey 生成の共通モジュール（二重実装禁止） |
| `src/topicCandidates.ts` | topic 候補生成、topic スコア（official-only 減点あり） |
| `src/summarizeWithGemini.ts` | LLM 呼び出し（Gemini/DeepSeek）と要約プロンプト |
| `src/auditSources.ts` / `auditHotSearch.ts` | AI なしのソース診断 |
| `config/sources.json` | 収集元定義（sourceType 宣言、URL パターン） |
| `docs/editorial-character.md` | 編集方針の正本 |
| `docs/roadmap.md` | フェーズ計画・受け入れ基準・引継ぎ運用 |

## コマンドと検証

```bash
npm run check          # 型チェック（変更後は必ず）
npm run audit:sources  # AIなしのソース診断 → output/source-audit-*.{json,md}
npm run start          # フル実行 → output/*.md + selection_trace_*.json
```

- **ローカルは Gemini API に接続できない**（Connect Timeout、既知）。AI 要約込みの検証は
  GitHub Actions の generate-news（provider: deepseek）で行う。ローカルでは selection_trace までが検証範囲
- 変更前後で trace/audit を比較する。守るべき実測ライン:
  候補プールの官庁比率 ≦ 50% / 媒体ソースの fresh > 0 / official-only topic は low 優先

## 守るべき設計原則

1. **存在しない SNS 反応・背景情報を作らない**。元記事にある情報だけを使う（プロンプトの禁止事項を弱めない）
2. **外部取得はすべて graceful fallback**。1ソース/1ルートの失敗で全体を止めない。失敗は診断ログに残す
3. **公式ソースだけで完結する topic は低評価**。media/SNS/data の裏付けで加点する向きを崩さない
4. **エンタメキーワードゲートは reliability A + `requireEntertainmentKeywords: true` のみ**。
   媒体（B/C/D）に安易に再適用しない（芸能見出しが全滅した過去がある）
5. **topicKey のロジックは `src/topicKey.ts` だけ**に置く。他所に再実装しない
6. **selection_trace / source-audit の診断項目を壊さない**。新しい除外・選定理由は必ず trace に理由を残す
7. 秘密情報（API キー）は `.env` / GitHub Secrets のみ。コード・ログに書かない

## タスクの進め方

- `docs/roadmap.md` のタスクを番号順に。1タスク=1受け入れ基準で完結させる
- 完了時は roadmap のフェーズ状況を更新（✅ + 実測値1行）してコミット

### ⚠️ 要所は Astra 担当（2026-09-06 更新）

タスクに着手する前に、roadmap の該当タスクに **⚠️ マーク**（「Astra に依頼推奨」等）が
付いていないか確認する。付いている場合、またはそのタスクが以下のいずれかに当たる場合は、
**担当が GPT-6 Astra ならそのまま進める。Astra 以外なら自分で分析・設計・実装を進めず、次のように知らせる**:

> このタスク（2-x）には Astra 担当部分（◯◯）が含まれます。
> ここは出力品質を左右する要所なので、GPT-6 Astra へ引き継ぎます。
> 切り替え・引き継ぎができない場合は、その部分を停止して受付へ報告します。

Astra に投げるべき合図（roadmap のモデル振り分け指針と一致）:

1. LLM プロンプトの初版設計・大きな書き換え（要約・抽出・判定のプロンプト）
2. フェーズ完了時の設計レビュー
3. 出力品質が狙いとずれた時の原因分析
4. アーキテクチャの分岐点（技術選定、選定単位の切替など）

⚠️ の付かない実装・調整・検証は、止まらずそのまま進めてよい。
迷ったら勝手に方針変更せず、上記の合図に当たるかで判断する。

ユーザー指示により、従来の Sol 案件は Astra 案件へ変更した。古い指示書の「Sol 必須／推奨」は現在の担当ルールとしては Astra と読み替える。日付付きの Sol／Fable 設計・検証記録は実績の来歴として保持する。この変更は開発担当の振り分けであり、ニュース生成APIのprovider/model・料金設定を変更する許可ではない。
