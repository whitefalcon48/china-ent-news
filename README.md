# 中国エンタメニュース Phase 0

中国の映画・ドラマ・芸能ニュース候補を集め、Geminiで日本語に整理し、Markdownで出力するための最小プロジェクトです。

この段階では、まだサイト化・自動公開・画像取得はしません。目的は「収集元の質」と「AI出力の読みやすさ」を確認することです。

## できること

- 設定ファイルに書いた収集元からニュース候補を取得します。
- URLとタイトルの近さで、簡単に重複を減らします。
- Gemini APIで日本語の要点・本文・確度・注意点を整理します。
- `output/YYYY-MM-DD.md` に1日分のMarkdownを出力します。

## セットアップ

最初に、このフォルダで以下を実行します。

```bash
npm install
```

## APIキーの設定

`.env.example` をコピーして、同じ場所に `.env` という名前のファイルを作ります。

```env
GEMINI_API_KEY=ここにGeminiのAPIキー
GEMINI_MODEL=gemini-2.5-flash-lite
MAX_ARTICLES=8
```

`GEMINI_API_KEY` はコードに直接書かず、必ず `.env` に入れてください。

## 実行方法

```bash
npm run start
```

開発中は以下でも同じように動きます。

```bash
npm run dev
```

Gemini APIの接続だけを確認したい場合は、以下を実行します。

```bash
npm run test:gemini
```

このテストでは、`.env` の `GEMINI_API_KEY` が読み込めているかを表示します。APIキー本体は表示しません。

実行すると、画面に以下のような結果が出ます。

```text
取得した記事数
重複除去後の記事数
AI処理した記事数
Markdown出力先
エラーがあった収集元
```

## 出力ファイルの確認

出力先は以下です。

```text
output/YYYY-MM-DD.md
```

Markdownの中では、SNS反応や未確認情報など、空だった項目は表示されません。

## GitHub ActionsでGemini接続を確認する

ローカル環境からGemini APIに接続できない場合でも、GitHub Actions上で接続できるかを確認できます。

この確認では、まだ毎朝自動実行やCloudflare Pages連携はしません。Gemini API接続テストだけを手動で実行します。

### 1. GitHubリポジトリを作る

この `china-ent-news` フォルダをGitHubリポジトリとして作成し、GitHubへアップロードします。

### 2. Secretを登録する

GitHubのリポジトリ画面で、以下を開きます。

```text
Settings → Secrets and variables → Actions → New repository secret
```

次のSecretを登録します。

```text
Name: GEMINI_API_KEY
Value: GeminiのAPIキー
```

APIキー本体はGitHub Actionsのログには表示されません。

### 3. Actionsから手動実行する

GitHubのリポジトリ画面で、以下を開きます。

```text
Actions → test-gemini → Run workflow
```

実行内容は以下だけです。

```text
npm install
npm run test:gemini
```

### 4. 結果ログを確認する

成功した場合は、ログに以下のように表示されます。

```text
GEMINI_API_KEY: 読み込み済み
接続結果: 成功
```

失敗した場合は、HTTPステータスやネットワークエラーの詳細が表示されます。APIキー本体は表示されません。

## 収集元の追加方法

収集元は `config/sources.json` で管理します。

```json
{
  "name": "収集元名",
  "url": "https://example.com/rss.xml",
  "type": "rss",
  "category": "映画",
  "reliability": "B",
  "enabled": true
}
```

`type` は `rss` または `html` です。最初はRSSを優先してください。HTMLはページ構造が変わると取得できなくなることがあります。

`reliability` は以下の目安です。

- `A`: 公式発表、本人発言、公的機関、公式データ
- `B`: 大手メディア、業界メディア、複数報道
- `C`: SNS話題、ファン反応、豆瓣・Weibo中心
- `D`: 营销号、匿名投稿、スクショ中心

`D` 単独の記事化は原則避けます。

## 編集方針

Geminiには、次の方針で整理するよう指示しています。

- 元記事にない情報を補わない
- 未確認情報を断定しない
- 事実、報道内容、SNS反応、未確認情報を分ける
- ゴシップでは本人・事務所・公式発表の有無を慎重に扱う
- 出典が弱い場合は確度を下げる
- 翻訳調ではなく、日本語として読みやすく再構成する
- 人物を貶める表現を避ける

## よくあるエラー

### `GEMINI_API_KEY is not set`

`.env` がないか、APIキーが入っていません。`.env.example` をコピーして `.env` を作ってください。

### 取得した記事数が0件になる

収集元のページ構造が変わった、アクセスが一時的にブロックされた、またはキーワード判定に引っかかっていない可能性があります。`config/sources.json` に別のRSSや公開ページを追加してください。

### Gemini API error

APIキー、モデル名、利用上限、ネットワーク接続を確認してください。モデル名は `.env` の `GEMINI_MODEL` で変更できます。

### Gemini APIで `fetch failed` が出る

ニュース取得は成功しているのにAI処理だけ `fetch failed` になる場合は、GoogleのGemini APIへ接続できていない可能性があります。

まず以下を実行してください。

```bash
npm run test:gemini
```

確認すること:

- `.env` が `package.json` と同じフォルダにあるか
- 変数名が `GEMINI_API_KEY` になっているか
- APIキーが有効か
- `GEMINI_MODEL` の名前が正しいか
- Google APIへの通信がネットワークやVPNで制限されていないか
- 会社・学校・地域のネットワーク制限で `generativelanguage.googleapis.com` に接続できない状態ではないか
- セキュリティソフトやプロキシがNode.jsからの通信を止めていないか

通常実行でGemini処理に失敗した記事は、Markdown内に「AI処理失敗」と原因メモとして出力されます。

### Markdownはできたが記事が少ない

Phase 0では品質確認を優先しているため、`MAX_ARTICLES` の数だけ処理します。必要なら `.env` の数字を増やしてください。
