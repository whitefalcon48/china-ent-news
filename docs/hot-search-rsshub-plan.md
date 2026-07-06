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

## 代替ルート候補の調査メモ

RSSHub公式docsは、この環境からは403で安定参照できなかった。
そのため、以下は「次に検証する候補リスト」として扱い、実装時は `WEIBO_HOT_SEARCH_ROUTES` のような診断用ルート設定で1つずつ実測する。

| 候補 | 期待できる情報 | 取得難易度 | 必要環境 | 安定性 | Phase 0での扱い |
| --- | --- | --- | --- | --- | --- |
| Weibo hot search (`/weibo/search/hot`) | 热搜ワード、順位、現地SNS温度。芸能・噂・炎上系の入口になる | 高 | RSSHub公開インスタンスまたは自前RSSHub。Cookie/Puppeteerが必要になる可能性あり | 低〜中。Weibo側制限とRSSHub側負荷の影響が大きい | まずaudit専用。成功しても本番生成にはまだ混ぜない |
| Bilibili hot search | 若年層・動画圏の話題、作品名、俳優名、二創/ファン反応の兆候 | 中 | RSSHub公開インスタンスで取れる可能性。Cookieは不要な可能性が比較的高い | 中。Weiboよりは安定する可能性 | 代替SNS温度ソース候補 |
| Bilibili ranking | 映像・アニメ・综艺関連のランキング、再生/人気傾向 | 中 | RSSHub公開インスタンスで取れる可能性。カテゴリ指定が必要になる可能性 | 中 | 热搜よりニュース性は弱いが、現地消費の温度確認に有用 |
| Douban movie related | 映画評価、公開作、スコア、コメント傾向の入口 | 中〜高 | RSSHub公開またはDouban側制限に依存。Cookieが必要になる可能性 | 低〜中 | 興行・作品評価の補助。単独ニュース化は避ける |
| Maoyan movie related | 興行、上映中作品、ランキング、公開予定 | 中 | RSSHub公開または別API/HTML取得。Cookie不要の可能性はあるが仕様変動あり | 中 | 映画興行データの補助。公式/媒体報道と組み合わせる |

優先順は、現地SNS温度を拾うなら Weibo、安定取得を優先するなら Bilibili、映画興行の補助なら Maoyan。
ただし、どれもPhase 0ではまず `audit:sources` の診断枠にだけ出し、通常候補には混ぜない。

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
