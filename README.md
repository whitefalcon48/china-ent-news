# 中国エンタメニュース Phase 0

中国の映画・ドラマ・芸能ニュース候補を集め、AIで日本語の軽いニュースメモに整理し、Markdownで出力するための最小プロジェクトです。

この段階では、まだサイト化・自動公開・画像取得はしません。目的は「収集元の質」と「AI出力の読みやすさ」を確認することです。

## できること

- 設定ファイルに書いた収集元からニュース候補を取得します。
- URLとタイトルの近さで、簡単に重複を減らします。
- DeepSeekまたはGeminiで、日本語の軽いニュースメモに整理します。
- コラム、レビュー、インタビュー、静的ページは原則除外します。
- articleType、topic_key、source_countなどの内部データを持ちます。
- `output/YYYY-MM-DD-deepseek.md` など、provider名つきMarkdownを出力します。

## Phase 0の現在の方針

目標は、検証レポートではなく、ナルエビちゃんニュース型の最新順フィードです。

編集キャラクター方針は以下に保存しています。

```text
docs/editorial-character.md
```

このサイトは、中国語記事を日本語に翻訳・要約するニュースサイトではありません。中国現地で実際に評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋めることを目的にしています。

表に出すMarkdownは、以下のような軽い構成にしています。

```markdown
## 【カテゴリ｜確度B】タイトル

リード文。2〜3行で、何が起きたかがわかる文章。

### 何が起きた？
短く整理。

### 反応・見られ方
SNS反応や複数メディアでの見られ方がある場合のみ。

### ひとこと
必要な場合のみ。

ソース：媒体名1、媒体名2
```

裏側では、以下を内部データとして持ちます。

- `source_count`
- `source_list`
- `has_official_source`
- `has_multiple_sources`
- `has_sns_signal`
- `article_type`
- `skip_reason`
- `verification_status`
- `topic_key`
- `main_entities`
- `related_sources`

Phase 0の品質検証では、現時点では `deepseek` を推奨providerにします。Gemini対応も残しています。

## 出力品質の目安

1記事あたりの標準ボリュームは、日本語でおおむね400〜700字です。

- 通常記事: 400〜700字
- 公式発表系: 300〜500字でも可
- ゴシップ・騒動系: 500〜800字

raw本文が短すぎる記事は、無理に薄い本文を出さず、出力対象から外します。現在はAI処理前に記事ページ本文を取得し、`rawContentLength` をログに出します。

```text
AI処理中: タイトル
source: 1905电影网 新闻
rawContentLength: 1240
articleType: news_event
category: 映画
```

`rawContentLength` は、AIに渡した元本文のおおよその文字数です。ここが短い記事が多い場合、出力が薄くなる原因を判断できます。

## バッジと内部メタデータ

通常ニュースとSNS観測メモは、同じフィード内に混ぜます。ただし、バッジで明確に分けます。

```text
NEWS
HOT SEARCH
WATCH
OFFICIAL
DATA
PR WATCH
```

内部データには以下を持ちます。

```json
{
  "badge": "NEWS",
  "source_type": "media_report",
  "published_date": "",
  "event_date": "",
  "freshness_label": "recent",
  "newsworthiness_score": 0,
  "japan_visibility": "unknown",
  "japan_gap": "unknown",
  "context_value": "medium",
  "sns_heat": "none",
  "editor_comment": "",
  "japan_context_note": ""
}
```

表示では、バッジ、確度、鮮度、情報源タイプ、ソースリンク、ひとことを優先して見せます。

```markdown
## 【NEWS｜映画｜確度B｜6/20】張頌文が金爵賞男優賞、上海映画祭は“中国映画の現在地”が見える結果に

情報源タイプ：media_report

### ひとこと
...
```

## 鮮度管理

`published_date` は元記事の公開日、`event_date` は出来事の発生日です。

`freshness_label` values:

- `today`: age 0 days
- `yesterday`: age 1 day
- `recent`: age 2-7 days
- `stale`: age 8-30 days
- `old`: age 31+ days
- `unknown`: date is missing

Normal feed candidates should be `today`, `yesterday`, or `recent`. `stale`, `old`, and `unknown` are excluded before AI processing.

## topic統合

同じ作品、人物、映画祭、イベントに関する記事は、できるだけ1トピックに寄せます。

- `topic_key` が近いものをまとめます。
- 複数ソースがある場合は、1記事内の `source_list` に統合します。
- 統合しきれない場合も、ログに `重複候補` として出します。

## HOT SEARCH / 热搜メモ

Weibo热搜の芸能・ファン文化・噂・炎上系は、将来的に `HOT SEARCH` として通常フィード内に混ぜます。

現時点では本格取得は未実装です。取得できない場合は graceful fallback としてログに出し、存在しないSNS反応は作りません。

## セットアップ

最初に、このフォルダで以下を実行します。

```bash
npm install
```

## APIキーの設定

`.env.example` をコピーして、同じ場所に `.env` という名前のファイルを作ります。

```env
AI_PROVIDER=deepseek

GEMINI_API_KEY=ここにGeminiのAPIキー
GEMINI_MODEL=gemini-2.5-flash-lite

DEEPSEEK_API_KEY=ここにDeepSeekのAPIキー
DEEPSEEK_MODEL=deepseek-chat

MAX_ARTICLES=8
```

APIキーはコードに直接書かず、必ず `.env` またはGitHub Secretsに入れてください。

## GeminiとDeepSeekの切り替え

使うAIは `.env` の `AI_PROVIDER` で切り替えます。

```env
AI_PROVIDER=deepseek
```

または:

```env
AI_PROVIDER=gemini
```

必要なAPIキーは以下です。

```env
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...
```

モデル名は必要に応じて変更できます。

```env
GEMINI_MODEL=gemini-2.5-flash-lite
DEEPSEEK_MODEL=deepseek-chat
```

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

DeepSeek APIの接続だけを確認したい場合は、以下を実行します。

```bash
npm run test:deepseek
```

このテストでは、`.env` の `DEEPSEEK_API_KEY` が読み込めているかを表示します。APIキー本体は表示しません。

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
output/YYYY-MM-DD-gemini.md
output/YYYY-MM-DD-deepseek.md
```

Markdownの中では、SNS反応や未確認情報など、空だった項目は表示されません。

ソースは媒体名だけでなく、可能な限りMarkdownリンクで出力します。

```markdown
ソース：[1905电影网 新闻](https://...)、[界面新闻 影视产业](https://...)
```

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

## GitHub ActionsでニュースMarkdownを生成する

GitHub Actions上で、ニュース収集からGemini要約、Markdown生成まで通るかを手動で確認できます。

この確認では、まだGitHubへの自動commit、毎朝自動実行、Cloudflare Pages連携はしません。生成されたMarkdownをartifactとしてダウンロードして確認します。

### 1. GitHubリポジトリを用意する

`china-ent-news` フォルダをGitHubリポジトリとしてアップロードします。

### 2. Secretを登録する

GeminiとDeepSeekを比較する場合は、両方のSecretを登録します。GitHubのリポジトリ画面で以下を開きます。

```text
Settings → Secrets and variables → Actions → New repository secret
```

次のSecretを登録します。

```text
Name: GEMINI_API_KEY
Value: GeminiのAPIキー
```

```text
Name: DEEPSEEK_API_KEY
Value: DeepSeekのAPIキー
```

APIキー本体はGitHub Actionsのログには表示されません。

### 3. Actionsから手動実行する

GitHubのリポジトリ画面で、以下を開きます。

```text
Actions → generate-news → Run workflow
```

`provider` で使うAIを選びます。

```text
gemini
deepseek
```

実行内容は以下です。

```text
npm install
npm run start
```

### 4. artifactをダウンロードする

workflowの実行が完了したら、実行結果ページの `Artifacts` から以下をダウンロードします。

```text
generated-news-markdown-gemini
generated-news-markdown-deepseek
```

中に `output/YYYY-MM-DD-gemini.md` または `output/YYYY-MM-DD-deepseek.md` が入っています。このMarkdownを見て、軽いニュースメモとして読めるか、コラムや静的ページが除外されているかを確認してください。

### 5. ログを見る

ログには、取得した記事数、articleType別件数、除外件数、除外理由、topic_key生成件数、最終出力件数、source別配分、provider名が表示されます。APIキー本体は表示されません。

追加で、以下も表示します。

- badge別件数
- source_type別件数
- freshness_label別件数
- topic統合件数
- 重複候補
- HOT SEARCH取得成功/失敗
- newsworthiness_score 上位記事

カテゴリ配分も表示されます。

```text
最終出力のカテゴリ配分
- 映画: n件
- ドラマ・配信: n件
- 芸能・俳優: n件
- 業界動向: n件
- 公式発表: n件
```

現在のAI処理対象選定では、同一sourceに加えてカテゴリ上限も設定しています。

- 映画: 最大3本
- ドラマ・配信: 最大2本
- 芸能・俳優: 最大2本
- 業界動向: 最大2本
- 公式発表: 最大2本
- 海外中国映画祭・文化交流: 最大1本

海外の中国映画祭開幕記事、文化交流イベントの定型発表、協定締結だけの記事、似た公式発表、内容が薄い告知は低優先度扱いにします。ゼロにはしませんが、1回の出力で複数並ばないようにしています。

### 6. GeminiとDeepSeekの比較ポイント

同じ日に `gemini` と `deepseek` の両方で `generate-news` を実行し、Markdownを見比べます。

確認すること:

- 中国人名・作品名が壊れていないか
- 元記事にない背景や一般論を補っていないか
- 表面のMarkdownが硬い検証レポートではなく、軽いニュースメモになっているか
- コラム、レビュー、インタビュー、静的ページが除外されているか
- `何が起きた？` が短く整理されているか
- SNS情報がない記事で、反応を勝手に作っていないか
- 1ソースだけなのに無理に複数視点を作っていないか
- ゴシップや未確認情報で断定表現になっていないか
- 日本語が翻訳調ではなく、自然に再構成されているか

## 収集元の追加方法

収集元は `config/sources.json` で管理します。

```json
{
  "name": "収集元名",
  "url": "https://example.com/rss.xml",
  "type": "rss",
  "category": "映画",
  "reliability": "B",
  "includeUrlPatterns": ["/news/"],
  "excludeUrlPatterns": ["/video/", "/photo/", "gallery"],
  "enabled": true
}
```

`type` は `rss` または `html` です。最初はRSSを優先してください。HTMLはページ構造が変わると取得できなくなることがあります。

`includeUrlPatterns` は、候補に含めたいURLパターンです。空欄ならすべて対象になります。

`excludeUrlPatterns` は、候補から除外したいURLパターンです。動画ページ、画像ギャラリー、広告ページなどを外すために使います。Phase 0では、1905电影网の `/video/` 系URLを除外しています。

`reliability` は以下の目安です。

- `A`: 公式発表、本人発言、公的機関、公式データ
- `B`: 大手メディア、業界メディア、複数報道
- `C`: SNS話題、ファン反応、豆瓣・Weibo中心
- `D`: 营销号、匿名投稿、スクショ中心

`D` 単独の記事化は原則避けます。

## 編集方針

AIには、次の方針で整理するよう指示しています。

- 元記事にない情報を補わない
- 未確認情報を断定しない
- 表面は軽いニュースメモにする
- 検証情報は内部データとして持つ
- コラム、論説、レビュー、インタビュー、静的ページは単独掲載しない
- ソースはリンク付きで出す
- 映画・映画祭系だけに偏らないよう、カテゴリ配分を制御する
- raw本文が短すぎる記事は掲載しない
- タイトルには、事実だけでなく「なぜ面白いか」の角度を少し入れる
- 内部メモ型の表現ではなく、読者向けの `ひとこと` として編集者キャラの短い見方を出す
- 日本語圏では見えにくい文脈がある場合だけ、`日本語圏では見えにくいポイント` を出す
- 公式発表は確度Aでも、中立とは限らない。官製PRや文化輸出の文脈を考慮する
- HOT SEARCHや噂は断定せず、現地温度の観測メモとして扱う
- ゴシップでは本人・事務所・公式発表の有無を慎重に扱う
- 出典が弱い場合は確度を下げる
- 翻訳調ではなく、日本語として読みやすく再構成する
- 人物を貶める表現を避ける

ニュース選別では、以下を優先します。

- 日本語圏では知られていないが中国では重要
- 中国現地の評価・興行・热搜で強い
- 社会や制作環境の変化が見える
- 中国特有のファン文化が関係する
- 国家宣伝、文化輸出、海外中国映画祭などの文脈がある
- 日本公開、配信、字幕情報に関係する
- 複数ソースで確認できる

以下は優先度を下げます。

- 単なる受賞一覧
- 単なるノミネート羅列
- 式典が開催された、来賓が挨拶しただけの記事
- 官製PRをそのまま流すだけの記事
- コラム・論説・レビューそのもの
- ソースが弱い噂を事実のように扱う記事
- 動画一覧、画像ギャラリー、常設ページ

articleTypeは以下の分類です。

掲載候補:

- `news_event`
- `official_announcement`
- `data_report`
- `gossip_rumor`
- `sns_trend`

原則除外:

- `column_opinion`
- `review`
- `interview`
- `static_page`
- `unknown`

## よくあるエラー

### `GEMINI_API_KEY is not set`

`.env` がないか、APIキーが入っていません。`.env.example` をコピーして `.env` を作ってください。

### `DEEPSEEK_API_KEY is not set`

DeepSeekを使う設定なのにAPIキーが入っていません。`.env` またはGitHub Secretsに `DEEPSEEK_API_KEY` を設定してください。

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

通常実行でAI処理に失敗した記事は、Markdownには出さず、ログに原因を出します。

### JSON parse error

AIがJSON以外の文字列を返した場合、可能な範囲でJSON部分だけを取り出して処理します。それでも失敗した記事は、処理全体を止めずにログへ原因を出し、Markdownには掲載しません。

### Markdownはできたが記事が少ない

Phase 0では品質確認を優先しているため、コラム・レビュー・インタビュー・静的ページ・AI処理失敗記事は出力しません。そのため、出力が3〜5本程度になることがあります。

## Source audit mode

Run source diagnostics without calling Gemini or DeepSeek. This mode checks fetch health, URL exclusion, dedupe, date extraction, freshness, category, article type, and exclude reason.

Command:

```bash
npm run audit:sources
```

Outputs:

- `output/source-audit-YYYY-MM-DD.json`
- `output/source-audit-YYYY-MM-DD.md`

Freshness rules:

- `today`: age 0 days
- `yesterday`: age 1 day
- `recent`: age 2-7 days
- `stale`: age 8-30 days
- `old`: age 31+ days
- `unknown`: date is missing

Normal generation applies the same freshness gate before AI processing. Only `today` / `yesterday` / `recent` articles are normal candidates, and articles before 2026 are excluded from the normal feed. The audit Markdown makes it easier to see usable sources, empty sources, old-heavy sources, and movie-heavy sources.
