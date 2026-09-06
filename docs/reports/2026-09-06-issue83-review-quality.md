# Issue #83 レビュー修正失敗と日次品質差の調査報告

調査日: 2026-09-06
対象: 2026-08-31〜2026-09-06 に保存された日次データ、および Issue #83 のレビュー適用run
この報告書は保存データと実行記録の照合である。生成モデルの変更、再生成、公開、Issue返信、X投稿は行っていない。

## 結論

Issue #83 で起きたのは、自然文の修正指示を対象欄へ結び付けられなかった**システム側の対象特定の失敗**である。一方、「国家安全部とは何か」の説明を安全に書くための根拠claim・用語説明が保存されていないことは、別の**説明根拠不足**である。前者を直しても、後者をモデルの一般知識で埋めてはならない。

直近7生成日の記事品質には、保存本文入力の量・台帳成否・fallback経路・claimの役割付け・コメントgateの組合せによる差が見える。経路差は確認済みだが、品質差への寄与度を因果比較した検証は未実施である。原因に対応する恒久的な品質改善もまだ未解決である。以下の「強め／弱め」はAstraによる読解上の評価であり、客観スコアではない。

## #83 の実行事実

- OWNERコメント: [#5557836132](https://github.com/whitefalcon48/china-ent-news/issues/83#issuecomment-5557836132)、2026-09-06T07:48:34Z。
- bot返信: [#5557839107](https://github.com/whitefalcon48/china-ent-news/issues/83#issuecomment-5557839107)、2026-09-06T07:49:00Z。
- 対応run: [34020139841](https://github.com/whitefalcon48/china-ent-news/actions/runs/34020139841)、`issue_comment`、head/checkout `2d5c415`、2026-09-06T07:48:37Z開始。ログの2026-09-06T07:48:57Zは「修正対象のフィールドまたは元記事内の完全一致箇所を特定できませんでした」。
- review data に変更はなく、publish / X の各stepは全skipだった。ワークフローのsuccessと編集適用の成功は別である。受付時点の照合対象・原返信は[引継ぎ書](../handoffs/2026-09-06-issue83-review-quality.md)にも保存されている。

### 原指示（完全引用）

> 1 修正 事実がただ並べられているだけでわかりにくい。中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視など列挙している部分はいらないので、国家安全部とはなにか普通の人は知らない前提で。

`parseReviewComment` は修正指示を1件として受理し、理由tagは「その他」である。指示本文は「事実が…」から末尾まで欠落なく渡る。停止は `detectReviewRevisionIntent` での対象特定であり、AIが説明不足と判断したログではない。LLM呼出前に欄名・引用・数値・矢印という機械的アンカーがいずれも0件となり、変更してよい文章範囲を契約上決められなかった。

## 保存データの7日集計

`raw本文長` は最終記事の代表raw本文長、`URL / family` はtopic evidenceのURL数 / `media_family` のユニーク数である。転載・同文・検索ノイズを含みうるため、いずれも独立根拠数とは断言しない。

|生成日|最終記事|ledger成功/件数|fallback|raw本文長|evidence URL / family|情報完全性gate|最終状態|
|---|---:|---:|---|---|---:|---:|---|
|8/31|2|2/2|なし|6,332 / 2,639|6 / 6|41評価 / 4除外|selected 3 → output 2（1件はcomment claim gate）|
|9/1|0|0/0|なし|—|0 / 0|42 / 8|`no_candidate`|
|9/2|2|0/2|アーカイブledgerでは `ECONNRESET`、`null.choices`（現保存版は修正履歴を含むため別記録）|11,256 / 7,074|9 / 7|43 / 8|output 2|
|9/3|3|2/3|`finish_reason length`|976 / 5,831 / 7,075|16 / 10|36 / 6|output 3|
|9/4|1|1/1|なし|1,010|4 / 4|47 / 5|output 1|
|9/5|2|2/2|なし|1,230 / 1,256|10 / 5|49 / 6|output 2|
|9/6|1|1/1|なし|1,320|5 / 5|48 / 5|output 1|

合計は11記事、ledger成功8/11、fallback 3件、情報完全性gate 306評価 / 42除外である。traceの主なdrop理由は `topic_not_fresh` 434件、`evs_candidate_limit` 63件、`evs_below_threshold:4` 52件、`:2` 43件、`topic_no_publishable_evidence` 33件、`information_incomplete:title_echo_event` 28件だった。記事ごとの根拠は[8/31](../../data/2026-08-31/articles_2026-08-31.json)・[9/1](../../data/2026-09-01/selection_trace_2026-09-01.json)・[9/2](../../data/2026-09-02/articles_2026-09-02.json)・[9/3](../../data/2026-09-03/articles_2026-09-03.json)・[9/4](../../data/2026-09-04/articles_2026-09-04.json)・[9/5](../../data/2026-09-05/articles_2026-09-05.json)・[9/6](../../data/2026-09-06/articles_2026-09-06.json)、ledgerとtraceは各日同ディレクトリ内の `fact_ledger_*` / `selection_trace_*` を参照。

## 出力の具体例

### 強めの例: 9/5『早春晴朗』と8/31『ロミオ+ジュリエット』

『早春晴朗』の本文はNetflix非英語圏週間2位、配信・国内データを事実としてまとめ、注目ポイントは「原作では6年続く不均衡な関係だったのが、ドラマ版では尚之桃が自ら提案するオフィス地下恋に変わっています。この変更が、海外の視聴者にどう響いたのか気になります！」と、具体的な改変へ焦点を絞っている。[保存記事](../../data/2026-09-05/articles_2026-09-05.json)の `why_it_matters` は C16/C17/C18/C1 を参照し、ledger fallbackは空である。比較具体性は長所だが、「オフィス地下恋」だけでは日本語読者向けの意味説明が不足するため、全面合格の例ではない。[生成Markdown](../../data/2026-09-05/2026-09-05-deepseek.md)も同文を確認できる。

8/31『ロミオ+ジュリエット』も、神父を武術師匠へ替えるという具体的な差分を挙げる点が長所である。[保存記事](../../data/2026-08-31/articles_2026-08-31.json)のcommentはC2/C12を参照する。ただし結びは成都公演での反応を見たいという未来観測に留まる。

### 根拠追跡が弱い保存状態の例: 9/2『夏休み映画市場』と『歓迎来龍餐館』

前者の注目ポイントには「“クソ映画”扱い」「SNSでミーム化」「若い観客が…反応」などが含まれるが、`why_it_matters` のclaim refsは空で、アーカイブledgerは `ledger_extraction_failed: terminated / cause: read ECONNRESET` である。[記事](../../data/2026-09-02/articles_2026-09-02.json)と[アーカイブledger](../../data/2026-09-02/fact_ledger_2026-09-02.json)で照合できる。これはユーザーが気に入った記事の内容的魅力を否定するものではなく、根拠追跡上の弱さを示すだけである。後者もタイトル説明・17億元・豆瓣評価・社会派テーマに触れる一方、アーカイブledgerは `Cannot read properties of null (reading 'choices')`。現在の保存版は修正履歴入りで `generationMeta` が `review_saved_ledger_missing` のため、純初稿との単純比較はしない。fallbackが直ちに読みにくさを意味するわけでもない。

## 保存本文・fallback・gateから見える穴

親分析では、品質差は主に次の経路差と検査範囲の差に現れている。

1. [summarizeWithGemini.ts](../../src/summarizeWithGemini.ts) の125〜145行では台帳抽出失敗時、根拠本文を直接使うfallback要約へ分岐する。この経路には個別コメント段がないため、台帳あり経路と同じclaim付きコメント生成・検査を経ない。
2. 9/6『交鋒』のledgerはC4だけが `editorial_role: story_premise`、他10件は `other`、`terms: []`、traceの `term_expansion.attempted: []` である。[ledger](../../data/2026-09-06/fact_ledger_2026-09-06.json)と[trace](../../data/2026-09-06/selection_trace_2026-09-06.json)を参照。コメントはC2/C4/C5を参照するが、C5は本文で使われていない「現実主義創作方針」で、宣伝寄りの自己説明である。
3. [runCommentCheck](../../src/claimCheck.ts) の `comment_no_new_editorial_claim` は、全comment refsが本文使用済みで、かつcomment claimに `isEditorialInsightClaim` が無い時だけgateにする。9/6ではC4が `story_premise` なので、本文既使用でもこのgateは発火しない。C5のような新しいIDが1つある場合も同様に、具体的な関係説明が達成されていることまでは保証しない。コメント段が成功しgateが0件でも、「気になる」「初回の反応を確認したい」は通りうる。
4. 9/6のstandard depthは `eligible 11 / used 3 / coverage 0.273 / passed` である。[保存記事](../../data/2026-09-06/articles_2026-09-06.json)の `article_depth` と[深度判定実装](../../src/articleDepth.ts)を参照。standard profileのpassedは、読みやすさや説明価値を保証しない。

## 『国家安全部の役割』について確認できる範囲

9/6のC2は「国家安全部が主導創作し、中央広播電視総台、国家安全部国安影視中心、中国電視劇制作中心、柠萌影視などが出品」とする制作クレジットである。C4は「市国家安全局の一対の師徒（師弟）が、機密漏えい事件を起点に20年にわたり境外スパイと対決する物語」とする筋書きである。[fact ledger](../../data/2026-09-06/fact_ledger_2026-09-06.json)のC2/C4、[保存raw本文](../../data/2026-09-06/articles_2026-09-06.json)、[生成Markdown](../../data/2026-09-06/2026-09-06-deepseek.md)で確認できる。

一方、国家安全部そのものの職掌・役割を説明するclaimもtermもなく、保存したsource本文にも説明は見つからない。したがって「普通の人は知らない前提」の説明を生成モデルの一般知識だけで補うことはしない。なお9/6のevidenceはURL 5件・family 5件だが、TapTapは別作品『伍六七：暗影交鋒』の検索ノイズ、Sinaは新京報転載で、ledgerはその転載を `near_duplicate_repost` としてverified factには使用不可にしている。

## 今回の変更範囲と限界

今回の修正は、長い完全一致の自然文アンカー、65%の非明示scope保護、複合指示を全件渡すprompt、役割根拠と単なるclaim参照の区別、失敗返信の具体化に限定する。[instructionAnchors](../../src/review/instructionAnchors.ts)、[revisionPatch](../../src/review/revisionPatch.ts)、[applyReview](../../src/review/applyReview.ts)、[revisionReply](../../src/review/revisionReply.ts)、[回帰テスト](../../src/testReviewRevisionFlow.ts)を参照。

これは全ての自然文を自動処理する変更ではない。また実モデルを使う検証は未実施で、日次品質ムラも未解決である。term・role・説明価値を求めるprompt指示だけでは、意味的な支持を完全自動検証したことにはならない。今回、生成provider/model、コスト方針、大幅な生成プロンプト方針は変更しない。

## 今後の提案

1. 既存の[ソース深度・鮮度作業 `6d642e9`](../../docs/handoffs/2026-09-06-issue83-review-quality.md)との重複を避け、根拠本文の取得・鮮度改善を先に統合検討する。
2. fallback経路を読める形で可視化し、説明に必要な根拠が足りない記事は、生成で埋めず保留できるようにする。
3. claimの数・参照有無だけでなく、読者に渡す具体的な価値、宣伝文句の帰属、説明の不足を評価する品質gateを別途設計する。
4. 追加根拠の取込みから台帳補強、修正案生成までをつなぐ編集フローを別途設計する。レビュー指示にURLを貼るだけで既存記事へ根拠が増えるものではない。このフローは今回未実装で、本番変更もしていない。

これらは生成品質の要所なので、設計・大幅な生成プロンプト変更・provider/model/コスト方針の変更は今回の範囲外として、Astraで別途判断する。

## #83で使う短い指示例・検証・commit

現時点での短い指示例は次のとおりである。

> 1 修正 本文の制作団体の列挙を削除してください。国家安全部が制作を主導した点と、ほかの文は残してください。

原指示は `parseReviewComment` で1件として受理され、対象範囲の特定に成功することを確認した。この短い指示はscopeと手書きfixture patchによる限定削除をローカル確認済みである。制作文は「国家安全部が主導して制作された。」へ、ほかの文は全文不変で維持する。根拠不足を注入したfixtureではclarification 1 callで停止する。実LLM応答での成功は未検証であり、この削除だけでは国家安全部の役割説明を追加できない。役割説明には別途資料が必要である。ただし、レビュー指示へ資料URLを貼るだけでは新資料は自動取得も台帳追加もされない。`prepareStoredArticleRevision` は保存済みledgerがある場合にそれを再利用するためである。[reviseArticle.ts](../../src/review/reviseArticle.ts)の165〜184行を参照。資料の取込みと台帳補強は別作業として必要であり、この制約を返信でも説明する。

親Astraの最終コードレビュー後、次のローカル検証はすべて成功した: `npm run check`、`test:scoped-review-revision`（#57/#63/#79に加え `testNaturalReviewInstruction` をimportして#83を含む）、`test:review-revision-flow`、`test:review-presentation`、`test:publication-flow`、`test:evidence-integrity`、`test:editorial-insight`、`test:site-feed`、`test:x-posts`、`test:publication-history`、`test:lightweight-review-edit`。

作業branchは `codex/20260906-issue83-review-quality`、baseは `2d5c415`、開始時commitは `216c9cd` である。本件の変更commitは最終変更記録の `git log` を参照する。本番へのpush、PR、main統合、実Issueコメント、記事JSON適用、再生成、公開、X投稿、通知はいずれも未実施である。
