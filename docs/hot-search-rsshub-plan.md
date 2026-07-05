# HOT SEARCH / Weibo RSSHub 調査メモ

## 前提

Phase 0では、Weibo热搜を本格実装しない。
実装する場合は RSSHub の `/weibo/search/hot` が利用できる前提で、通常ニュースと同じフィード内に `HOT SEARCH` バッジ付きで混ぜる。

## 必要な環境変数案

```env
RSSHUB_BASE_URL=https://rsshub.app
WEIBO_HOT_SEARCH_PATH=/weibo/search/hot
WEIBO_HOT_SEARCH_ENABLED=false
WEIBO_HOT_SEARCH_TIMEOUT_MS=10000
```

自前RSSHubやミラーを使う場合は `RSSHUB_BASE_URL` を差し替える。
公開インスタンスはレート制限、ブロック、経路障害の影響を受ける可能性がある。

## 取得できる想定項目

RSSHubのRSS/Atomとして取得する場合、最低限は以下を想定する。

- title: 热搜ワードまたはトピック名
- url: Weibo検索/話題ページへのリンク
- published_at: RSS itemの日付があれば使用、なければ取得時刻
- rank: item順をrankとして扱う
- hot_value: description等に含まれる場合だけ抽出
- category: 取得できない場合は `sns_trend`

## 失敗時の扱い

- RSSHub HTTPエラー、タイムアウト、XML parse失敗は全体処理を止めない
- source audit では `HOT SEARCH: failed` または `empty` として表示
- generate-news では候補0として続行
- SNS反応は作らない。取得できた热搜項目だけを `article_type: sns_trend` として扱う

## Cookie / Puppeteer 前提

RSSHub公開ルートだけで取れるなら Cookie / Puppeteer は不要。
ただし Weibo側の仕様変更、ログイン要求、地域・IP制限でRSSHub側が失敗する場合がある。
その場合の優先順は以下。

1. RSSHub公開インスタンスを使う
2. GitHub Actionsから自前RSSHubまたは安定ミラーを叩く
3. Cookieが必要なRSSHub設定を検討する
4. Puppeteer直取得はPhase 0では避ける

## 最小実装案

1. `config/sources.json` には通常ソースとして混ぜず、専用fetcher `fetchHotSearchSource()` を追加
2. `WEIBO_HOT_SEARCH_ENABLED=true` のときだけ取得
3. RSS item上位10件を `RawArticle` に変換
4. `articleType=sns_trend`, `badge=HOT SEARCH`, `sourceType=sns`, `confidence=C/D` 相当で扱う
5. 公式発表・大手報道がない限り、本文では断定しない
6. auditには `not_configured / failed / empty / success` を必ず出す

## 注意

HOT SEARCHは真偽確認ではなく、現地温度の観測メモとして扱う。
通常ニュースと同じフィードに混ぜるが、必ず `HOT SEARCH` バッジで通常報道と区別する。