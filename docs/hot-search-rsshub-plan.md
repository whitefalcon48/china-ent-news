# HOT SEARCH / Weibo RSSHub 調査メモ

## 前提

Phase 0では、Weibo热搜を本格実装しない。
実装する場合は RSSHub の `/weibo/search/hot` が利用できる前提で、通常ニュースと同じフィード内に `HOT SEARCH` バッジ付きで混ぜる。

## 必要な環境変数案

```env
RSSHUB_BASE_URL=https://rsshub.app
WEIBO_HOT_SEARCH_ROUTES=/weibo/search/hot
WEIBO_HOT_SEARCH_ENABLED=true
WEIBO_HOT_SEARCH_TIMEOUT_MS=10000
```

自前RSSHubやミラーを使う場合は `RSSHUB_BASE_URL` を差し替える。
公開インスタンスはレート制限、ブロック、経路障害の影響を受ける可能性がある。
複数ルートを試す場合は `WEIBO_HOT_SEARCH_ROUTES=/weibo/search/hot,/other/route` のようにカンマ区切りで指定する。
互換用に `WEIBO_HOT_SEARCH_PATH` も読み取れるが、今後は複数候補を扱える `WEIBO_HOT_SEARCH_ROUTES` を優先する。
`WEIBO_HOT_SEARCH_ENABLED=false` の場合、source audit では `not_configured` として扱う。

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
- 現段階では generate-news の candidate_pool / deepseek_input には混ぜない
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

1. `config/sources.json` には通常ソースとして混ぜず、source audit 専用fetcherで取得する
2. `WEIBO_HOT_SEARCH_ENABLED=false` で明示停止できる
3. RSS item上位を診断用サンプルとして出す
4. エンタメ判定キーワードに一致した場合だけ `entertainment_match_reason` を出す
5. candidate_pool / deepseek_input にはまだ混ぜない
6. auditには `not_configured / failed / empty / success` を必ず出す

## 注意

HOT SEARCHは真偽確認ではなく、現地温度の観測メモとして扱う。
通常ニュースと同じフィードに混ぜるが、必ず `HOT SEARCH` バッジで通常報道と区別する。
