# 中国エンタメニュース収集・公開パイプライン

中国語圏で実際に話題になっている映画・ドラマ・芸能・業界ニュースを集め、根拠を確認したうえで日本語のニュース記事に整え、レビュー後に静的サイトへ公開するパイプラインです。

単なる翻訳・要約ではなく、中国現地の評価・熱搜・興行・制作環境と、日本語圏で見えている中国エンタメ像とのズレを拾うことを目的にしています。

- 本番サイト: <https://bingtangnews.0-w-0.net/>
- GitHub Pagesフォールバック: <https://whitefalcon48.github.io/china-ent-news/>
- 編集方針: [`docs/editorial-character.md`](docs/editorial-character.md)
- フェーズ状況と受け入れ基準: [`docs/roadmap.md`](docs/roadmap.md)

## 現在のパイプライン

```text
固定ソース + Weibo熱搜
  → 日付補完
  → URL / タイトル重複除去
  → 記事分類・スコアリング
  → topicKey生成・topic統合
  → topic候補生成・ソース拡張
  → 鮮度 / 履歴 / ソース数 / カテゴリ上限で選定
  → fact ledger・claim・記事深度・表記ゲート
  → LLM要約・編集コメント
  → Markdown / 日次データ保存
  → GitHubレビューIssue
  → OWNER承認
  → 静的サイト・OGP・X投稿文面
```

topic単位で複数ソースを扱う **topic-first** が既定です。`TOPIC_FIRST=false` を設定した場合のみ、旧来の記事単位選定へ戻せます。

## できること

- `config/sources.json` のRSS・HTMLソースから記事候補を取得
- Weibo熱搜をRSSHub経由で取得し、芸能・ファン文化などの候補を合流
- URL正規化、タイトル類似、topicKeyによる重複整理
- RSSHub / Serperによる追加ソース探索と本文検証
- source type（公式・媒体・SNS・データ）を分けた根拠管理
- fact ledger、claim check、記事深度、編集価値、用語・漢字・翻訳の品質ゲート
- DeepSeekまたはGeminiによる要約・編集コメント生成
- 日次候補をGitHub Issueで人間レビュー
- OWNERが持ち込んだURLを、日次生成とは分離して即時処理
- 承認済み記事から、アーカイブ・個別記事・タグ検索・OGPを含む静的サイトを生成
- 日次ダイジェストと個別投稿候補のX文面を生成
- 固定フィクスチャを使ったモデル比較

## 編集・公開の契約

記事には、読者向けの見出し・リード・「何が起きた？」・「反応・見られ方」・「ビンタンの注目ポイント」・出典を持たせます。内部では、根拠資料、claim refs、source mix、鮮度、選定理由を保持します。

特に次のルールを守ります。

- 元記事にないSNS反応、背景、数字、人物評価を作らない
- 噂や熱搜は、確認できた観測として扱い、事実のように断定しない
- 公式ソースだけで完結するtopicは低優先度にする
- 外部取得の失敗はgraceful fallbackにし、全体を止めず診断ログへ残す
- 通常フィードは `today` / `yesterday` / `recent` の候補だけを対象にする
- 同じtopicの再掲載は履歴を照合し、新しい根拠や更新がなければcooldownで止める
- `reliability: A` のソースに限り、`requireEntertainmentKeywords: true` の設定でエンタメキーワードゲートを適用する
- AI生成やclaim gateに失敗した記事は、薄い状態のまま公開しない

レビューゲートが有効な環境では、生成しただけの記事は公開されません。`review.json` が完了し、記事が `approved` になったものだけがサイトビルドへ入ります。

## セットアップ

Node.js 22系を推奨します。

```bash
npm install
```

`.env.example` を `.env` にコピーし、利用するAIと必要なキーを設定します。

```env
AI_PROVIDER=deepseek

DEEPSEEK_API_KEY=ここにDeepSeekのAPIキー
DEEPSEEK_MODEL=deepseek-v4-flash
LEDGER_AI_MODEL=deepseek-v4-pro
COMMENT_AI_MODEL=deepseek-v4-pro

# Geminiを使う場合
GEMINI_API_KEY=ここにGeminiのAPIキー
GEMINI_MODEL=gemini-2.5-flash-lite

# ソース拡張を使う場合
SERPER_API_KEY=ここにSerperのAPIキー

MAX_ARTICLES=8
EVS_REVIEW_RESCUE=true
EVS_REVIEW_RESCUE_THRESHOLD=6
EVS_REVIEW_RESCUE_LIMIT=3
```

APIキーはコードや通常ログに書かず、ローカルでは `.env`、GitHub ActionsではSecretsに保存してください。

主な環境変数:

- `AI_PROVIDER`: `deepseek` または `gemini`。通常のGitHub ActionsはDeepSeekを使用
- `RUN_DATE`: `YYYY-MM-DD` の日付を指定して再生成
- `REVIEW_GATE`: `false` にするとローカル確認用にレビューを無効化。通常運用では有効のままにする
- `SERPER_API_KEY`: 追加ソース探索に使用。未設定時はその経路だけgraceful fallback
- `WEIBO_HOT_SEARCH_ENABLED=false`: Weibo熱搜を停止
- `RSSHUB_BASE_URL`: RSSHubの接続先を変更
- `TOPIC_FIRST=false`: topic-firstを無効化
- `SITE_DATA_DIR` / `SITE_OUTPUT_DIR`: データ・サイト出力先を変更

## ローカルでの実行

変更後の最低限の確認:

```bash
npm run check
```

AIを呼ばずに収集元・日付・鮮度・除外理由を確認:

```bash
npm run audit:sources
```

通常のニュース生成:

```bash
npm run start
# npm run dev でも同じ
```

ローカル生成の主な出力は `output/` です。

```text
output/YYYY-MM-DD-deepseek.md
output/selection_trace_YYYY-MM-DD.json
output/topic_candidates_YYYY-MM-DD.json
output/source-audit-YYYY-MM-DD.json
output/source-audit-YYYY-MM-DD.md
```

日次データを保存し、既存データからサイトを生成する場合:

```bash
npm run persist:data
npm run build:site
```

`build:site` の既定出力は `dist/site` です。サイトURLやベースパスを指定する場合は次のようにします。

```bash
SITE_URL=https://bingtangnews.0-w-0.net SITE_BASE_PATH= SITE_OUTPUT_DIR=dist/lolipop-site npm run build:site
```

Windows PowerShellでは、実行前に `$env:SITE_URL` などへ設定してください。

## GitHub Actionsの運用

### `generate-news`

毎日のニュース生成と、手動再生成を行います。手動実行では次を指定できます。

- `run_date`: 過去日を含む生成日
- `provider`: `deepseek` または `gemini`
- `refresh_review`: 保存済み候補を置き換えて新しいレビューIssueを作るか
- `write_compare_fixture`: モデル比較用フィクスチャを保存するか

このworkflowは、ニュース生成 → artifact保存 → `data/` への日次データ保存 → レビューIssue作成までを行います。通常は `REVIEW_GATE=true` で動き、承認前にサイトへ公開しません。

### 日次レビュー

生成されたIssueには、次の形式でOWNERがコメントします。

```text
1 採用
2 却下 選定 却下理由
3 修正 口調 修正指示
残り採用
```

理由タグは `選定`、`口調`、`用語`、`事実`、`構成`、`その他` です。通常の記事がEVS 7点以上に届かない場合は、条件を満たすとIssue内の `救済再生成` でEVS 6点候補を最大3件までレビュー対象にできます。

`review-apply` は承認・修正・却下を反映し、承認完了後にサイトを再ビルドします。日次記事の公開URLは `/archive/YYYY-MM-DD/`、個別記事は `/t/YYYY-MM-DD/<番号>/` です。

### `manual-news-intake`

常設Issue（`manual-news-intake` ラベル）へ、OWNERが1コメント1 URLで投稿すると、日次ランキングを待たずに持ち込みルートが始まります。

```text
https://example.com/news/123
気になった理由：ファンの反応が大きい
```

URL安全検査、topic化、root / related evidence、fact ledger、claim・表記ゲートを通過した記事だけが専用レビューIssueへ進みます。承認前は公開されません。状態と中間データは `data/manual-intake/<comment-id>/` に保存され、同じコメントの再実行でIssueを二重作成しません。

詳細は [`docs/design-manual-news-intake.md`](docs/design-manual-news-intake.md) を参照してください。

### `deploy-site`

`main`への関連ファイルのpush、または手動実行でサイトをビルドします。

- 本番: `dist/lolipop-site` → LolipopへFTPS配信
- フォールバック: `dist/site` → GitHub Pages
- 配信対象の生成・レビュー・デプロイは `china-ent-news-production` concurrency groupで直列化

詳細は [`docs/deployment-lolipop.md`](docs/deployment-lolipop.md) を参照してください。

## X投稿文面

承認済みの日次データから、X換算280以内の日次ダイジェストと個別投稿候補を生成します。

```bash
npm run post:x
```

既定はdry-runで、`output/x_posts_YYYY-MM-DD.md` を作ります。実投稿は `X_POST_LIVE=true` と以下のSecretsを設定したworkflowからのみ行います。

```text
X_API_KEY
X_API_SECRET
X_ACCESS_TOKEN
X_ACCESS_SECRET
```

運用はまず生成文面を人が確認して予約投稿する半手動方式です。詳細は [`docs/x-bot-operations.md`](docs/x-bot-operations.md) を参照してください。

## 収集元の追加

収集元は `config/sources.json` に追加します。

```json
{
  "name": "収集元名",
  "url": "https://example.com/rss.xml",
  "type": "rss",
  "category": "映画",
  "reliability": "B",
  "sourceType": "media_report",
  "includeUrlPatterns": ["/news/"],
  "excludeUrlPatterns": ["/video/", "/photo/"],
  "requireEntertainmentKeywords": false,
  "enabled": true
}
```

`type` は `rss` または `html`、`sourceType` は `official` / `media_report` / `sns` / `data` です。source typeとreliabilityは、候補の優先度・バッジ・source mixの根拠になるため、実態に合わせて設定してください。

## 主なコマンド

| コマンド | 用途 |
|---|---|
| `npm run check` | TypeScript型チェック |
| `npm run start` | ニュース収集・選定・AI生成 |
| `npm run audit:sources` | AIなしの収集元診断 |
| `npm run build:site` | `data/` から静的サイトを生成 |
| `npm run persist:data` | `output/` の日次生成物を `data/` に保存 |
| `npm run review:issue` | 日次レビューIssueを作成 |
| `npm run review:apply` | レビューコメントを反映 |
| `npm run intake:process` | 持ち込みコメントを処理 |
| `npm run post:x` | X文面を生成。既定はdry-run |
| `npm run compare:models` | 固定フィクスチャでモデル比較 |
| `npm run test:site-feed` | サイトフィード・公開条件の回帰テスト |
| `npm run test:review-presentation` | レビュー表示と記事契約の回帰テスト |
| `npm run test:manual-intake` | 持ち込みルートの回帰テスト |

全スクリプトは `package.json` の `scripts` にあります。

## データと主要ファイル

```text
src/index.ts                 メインパイプライン、選定、selection trace
src/fetchSources.ts          固定ソース取得、URL・日付・本文抽出
src/fetchHotSearch.ts        Weibo熱搜取得
src/classifyArticle.ts       記事分類・ニュース価値スコア
src/topicKey.ts              topicKey生成の唯一の実装
src/topicCandidates.ts       topic候補とtopicスコア
src/expandSources.ts         RSSHub / Serperによるソース拡張
src/factLedger.ts            根拠台帳の生成
src/claimCheck.ts             claimと根拠の確認
src/summarizeWithGemini.ts   DeepSeek / Gemini呼び出しと要約
src/review/                  レビューIssue、修正、承認処理
src/intake/                  持ち込みニュース処理
src/site/                    静的サイト、OGP、X文面
config/sources.json          収集元定義
data/YYYY-MM-DD/             日次の正本データ
data/manual-intake/          持ち込みニュースの正本データ
```

## よくある確認

### ローカルで候補が少ない

まず `npm run audit:sources` を実行し、取得失敗・古い記事・エンタメゲート・重複除外を確認します。通常生成では鮮度、topic履歴、source/category上限、根拠ゲートを通るため、取得件数と最終記事数は一致しません。

### ローカルのGemini接続だけ失敗する

この環境ではGemini APIへの接続がタイムアウトすることがあります。`npm run test:gemini` でキーと接続を確認し、AI込みの検証はGitHub Actionsの `generate-news`（通常はDeepSeek）で行います。APIキー未設定の場合は `.env` またはActions Secretsを確認してください。

### 生成できたのに公開されない

レビューゲートが有効な場合、生成成功だけでは公開されません。対象日付の `data/YYYY-MM-DD/review.json` で、レビューが `completed`、対象記事が `approved` かを確認してください。

### topicや選定理由を調べたい

`output/selection_trace_YYYY-MM-DD.json` と `output/topic_candidates_YYYY-MM-DD.json` を確認します。収集元全体の健康状態は `output/source-audit-YYYY-MM-DD.{json,md}` に出力されます。

## 開発時の注意

- 変更前に必ず [`docs/roadmap.md`](docs/roadmap.md) を読み、該当タスクの受け入れ基準を確認する
- topicKeyのロジックを別ファイルへ再実装しない
- selection traceとsource auditの診断項目を壊さない
- 外部取得は必ずgraceful fallbackにする
- APIキー・raw HTML・API応答全文・URL query/hashなどの秘密または不要な生データを保存しない
- 生成品質を左右するLLMプロンプト初版、フェーズ設計レビュー、品質原因分析、アーキテクチャ分岐は、roadmapのSol推奨ルールに従う

関連する設計資料は `docs/` にまとめています。
