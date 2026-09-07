# 工程C C0 比較基盤レポート

2026-09-07 / 実装担当 / 状態: Astraレビュー待ち

設計正本はAstra設計commit `00da1aaa896ed7e3e536b1b8159bb8e11643d541` の
`docs/design-stage-c-reader-context-quality.md` と
`docs/handoffs/2026-09-07-stage-c-implementation.md`。実装baseは
`be0256909b5fbceed7c55c6ff1c5d49b50fa4e64`。

## C0で追加したもの

- `EvidenceManifest v1`: 実際に渡された `RawArticle[]` の順でE番号を一度だけbindし、URLと本文SHA-256から文書versionを識別する純粋helper。
- 文書単位の引用照合: 空白正規化だけを許し、別Eに同じ引用があっても指定Eの文書に存在しなければerror診断にする。
- append-only明示import: 工程BのようにC/E/URL/hashが明示された補足だけを末尾へ追加し、衝突・飛び番を拒否する。
- 読取専用比較CLI: 8月31日〜9月6日の固定dataを読み、指定した `output/` にだけmanifestを保存する。`data/` 配下への出力は拒否する。
- 旧記事互換: 旧候補配列からE番号を推測しない。取得時点不明は `null`、候補 `key_points` は全文と見なさず、全旧記事を `comparable=false` とした。

このC0では既存生成prompt、gate、選定、data、review、revisions、公開snapshot、サイト、OGP、X、通知、provider/model/費用設定を変更していない。生成経路への接続、自動品質得点、実LLM、外部取得も実施していない。

## 固定比較manifestの実測

実行:

```text
npm run quality:evaluation-manifest -- --output output/stage-c-evaluation-manifest.json
```

集計:

- 7生成日、11記事、0件日1日（2026-09-01）。
- ledger生成成功8記事、fallback 3記事。
- evidence保存記録51件。代表 `raw_content` 11件、候補 `key_points` 31件、title only 8件、工程Bの短い補足原文1件。
- 全文rawあり11件、全文raw欠損40件。`key_points` と短い補足原文は全文rawへ数えていない。
- `fetched_at` 既知1件、不明 `null` 50件。現在時刻による補完は0件。
- 明示済みC/E対応1件（2026-09-06 `C12/E5`）。旧配列から付け替えなかったlegacy未解決evidence記録50件、claim/evidence pair 186件。
- 新方式で同条件比較可能と判定した旧記事0件。理由は全11記事で生成時の完全な `RawArticle[]` snapshotが欠損しているため。
- 各入力JSONのGit blob SHA-1と基準repository SHAをmanifestへ記録した。

`raw欠損40件` は51件のevidence保存記録に対する数であり、記事数ではない。各記事には代表rawが1件ずつ残るが、その他の候補は全文ではなく `key_points` またはtitleだけである。

## 11記事一覧

|生成日|#|article_id|現行タイトル|ledger|版（draft/current/published）|evidence / raw欠損|既知C/E / legacy未解決pair|
|---|---:|---|---|---|---|---:|---:|
|2026-08-31|1|不明|AIGCと映画・文旅の融合を議論 長春で「影旅共生・智啓新篇」サロン開催|成功|legacy / legacy / なし|4 / 3|0 / 22|
|2026-08-31|2|不明|香港バレエ団『ロミオ+ジュリエット』、60年代香港を舞台にした濃厚な香港風リメイクで北京公演が閉幕|成功|legacy / legacy / なし|2 / 1|0 / 20|
|2026-09-02|1|a-c9d5a5c477f2856c|「史上最も混乱した夏休み映画シーズン」に　5年ぶりに30億元超えの大ヒット作が不在、『功夫女足』が首位も|fallback|1 / 1 / 1|4 / 3|0 / 0|
|2026-09-02|2|a-7fa5759f4d5fb337|『ようこそ龍レストランへ』北大・清華でロードショー、タイトルに込めた意味を解説|fallback|1 / 4 / なし|5 / 4|0 / 0|
|2026-09-03|1|a-49050510140515dd|2026年夏休み映画興行、過去最高の上映回数で124.98億元 前年比4.45%増|成功|legacy / 1 / なし|5 / 4|0 / 29|
|2026-09-03|2|a-46a8b1b357997446|国内初のAIGC長編ドラマ『後西遊記』が上星放送開始、制作費は従来の10分の1以下|fallback|legacy / 1 / なし|6 / 5|0 / 0|
|2026-09-03|3|a-e541215688786526|映画『歓迎来龍餐館』番外編公開、沈騰と蒋奇明が異郷で共演|成功|legacy / 1 / なし|5 / 4|0 / 20|
|2026-09-04|1|a-31216abbac0352b4|2026年夏休み映画、総興行収入124.98億元で過去最高の上映回数|成功|legacy / 1 / 1|4 / 3|0 / 32|
|2026-09-05|1|a-595a7cca1cd736f9|映画『歓迎来龍餐館』興行収入20億元突破、9月18日日本公開へ|成功|legacy / 1 / 1|3 / 2|0 / 25|
|2026-09-05|2|a-e316b136af3a0bbe|中国ドラマ『早春晴朗』がNetflix非英語圏週間2位に 国産ドラマ史上最高位|成功|legacy / 1 / 1|7 / 6|0 / 21|
|2026-09-06|1|a-37d06fba5ca20f9c|国安（国家安全）題材ドラマ『交鋒』が9月6日放送開始、王凯＆彭昱畅らが出演|成功|1 / 2 / 2|6 / 5|1 / 17|

`legacy` は現行summaryを読める一方、別の生成時版snapshotとして証明できない状態。9月2日#2は初稿version 1と現行version 4を分離し、公開版なし。9月6日#1は工程B適用前version 1と現行・公開version 2を分離し、補足資料の `fetched_at=2026-09-06T13:25:46.143Z` と `C12/E5` を明示mapとして保持した。

fallback記事には生成時ledger claimがないためlegacy未解決claim/evidence pairは0だが、根拠追跡が成立した意味ではない。manifestでは `ledger_generation_failed` と完全入力欠損を別々に残した。

## Astraによる5軸baseline評価欄

C0実装担当は良し悪しを判定しない。次の欄はAstraが保存本文と支持原文を読んで追記する。

|生成日・#|根拠追跡|理解の前提|宣伝の帰属|具体性・関係|自然な日本語|
|---|---|---|---|---|---|
|2026-08-31 #1|未評価|未評価|未評価|未評価|未評価|
|2026-08-31 #2|未評価|未評価|未評価|未評価|未評価|
|2026-09-02 #1|未評価|未評価|未評価|未評価|未評価|
|2026-09-02 #2|未評価|未評価|未評価|未評価|未評価|
|2026-09-03 #1|未評価|未評価|未評価|未評価|未評価|
|2026-09-03 #2|未評価|未評価|未評価|未評価|未評価|
|2026-09-03 #3|未評価|未評価|未評価|未評価|未評価|
|2026-09-04 #1|未評価|未評価|未評価|未評価|未評価|
|2026-09-05 #1|未評価|未評価|未評価|未評価|未評価|
|2026-09-05 #2|未評価|未評価|未評価|未評価|未評価|
|2026-09-06 #1|未評価|未評価|未評価|未評価|未評価|

## 検証

以下をローカルで実行し、すべて成功した。

```text
npm run check
npm run test:evidence-manifest
npm run test:quality-evaluation-manifest
npm run test:review-evidence-supplement
npm run test:review-revision-flow
npm run test:evidence-integrity
npm run test:site-feed
git diff --check
```

- 専用suiteは固定fixture/mockのみ。ネットワーク、実LLM、実外部取得なし。
- `test:quality-evaluation-manifest` は入力dataの前後hash一致、`data/` 内への出力拒否、隔離temp出力を検証。
- `git diff -- data` は0件。保護data差分0。
- C1/C2、push、PR、main統合、本番適用・公開は未実施。
