# 設計: 持ち込みニュース即時生成ルート

## 1. 目的

Falさんが見つけたニュースソースを常設 GitHub Issue へ投稿し、日次生成を待たずに関連ソース調査・記事生成・人間レビューまで進める。持ち込みURLを単純要約せず、既存の fact ledger、claim refs、root corroboration / related angle 分離、表記検査を通す。採用前には公開しない。

## 2. 利用方法

常設Issue（label: `manual-news-intake`）へ、OWNERが1コメント1件で投稿する。

```text
https://example.com/news/123
気になった理由：小規模だがファンの熱量が高い
```

- HTTP(S) URLはちょうど1件。
- 理由は任意。レビュー画面へ編集意図として表示するが、事実・claim・出典には使わない。
- `author_association == OWNER`、専用label、repository variable `NEWS_INTAKE_ISSUE_NUMBER` の一致をすべて必須にする。

## 3. 状態と保存場所

日次の `data/YYYY-MM-DD/` へ直接マージせず、GitHub comment id を冪等キーにする。

```text
data/manual-intake/<comment-id>/
  intake.json
  intake-state.json
  document.json
  topic.json
  expansion.json
  evidence-adequacy.json
  fact_ledger_<date>.json
  articles_<date>.json
  review.json
  review-issue.md
```

状態は `received -> fetching -> researching -> generating -> review_ready -> published`。失敗は `failed` とし、元URLのquery/hash、raw HTML、API応答全文、秘密値は保存しない。再実行時、既存のレビューIssue番号があれば新しいIssueを作らない。

## 4. 生成と根拠契約

```text
安全なURL取得
-> topic seed / candidate
-> root corroboration と related angle の限定探索
-> summarizeTopic の fact ledger
-> claim / comment / 表記ゲート
-> manual-news-review Issue
```

- 持ち込みで免除するのは日次ランキングとカテゴリ枠だけ。
- 関連角度はroot事実の複数ソース数・EVSを水増ししない。
- 取得本文が `usable` の場合だけ、source expansionが0件でも台帳とclaim gateへ進める。短いmetaや埋め込み本文しか取れない `limited`、またはUI殻だけの `unusable` は、中心事実が一致する全文検証済みroot資料を1件以上得られなければ `evidence_too_sparse` で止める。存在しない反応・背景は補わない。
- `summarizeTopic` が実際に使用したledgerを標準形式で保存し、修正再生成にも同じledgerを使う。
- 全記事でroot claim 3件以上を必須にし、興行・data report・context_value=highの記事はroot claim 6件以上、`key_numbers` を含む2種類以上の編集役割を必須にする。不足時はevidenceの範囲内で台帳抽出を1回だけ再試行し、なお不足なら `ledger_too_thin` としてレビューIssueを作らない。
- ledger欠落またはgated violationがある場合もレビューIssueを作らない。

## 5. レビュー・公開・X

- 生成成功時に1記事だけの `manual-news-review` Issueを作る。
- 既存と同じ `1 採用` / `1 修正 <タグ> <指示>` / `1 却下 <タグ> <理由>` を使う。
- `published`、review `completed`、記事 `approved` の3条件を満たした記事だけサイトビルド時に承認日のフィードへ合成する。
- 個別URLは `/t/<approval-date>/m-<comment-id>/` とし、後の日次記事追加でも変えない。
- 採用直後にPagesを再ビルドし、公開URLと個別X投稿候補をレビューIssueへ返信する。日次ダイジェストは再生成・再投稿しない。
- 日次レビューと持ち込みレビューのpush / Pages deployは同一ref単位で直列化する。

## 6. URL安全性

- URL内認証情報、localhost、private/link-local/reserved IP、任意ポートを拒否する。
- redirectは最大3回で各hopを再検査する。
- HTML/XHTML以外、サイズ上限超過、timeout、本文不足は安全に失敗する。
- Cookie、Authorization、API keyを外部URLへ送らない。
- GitHub Issueへの返信は固定された安全な理由だけにし、生の例外やURL queryを出さない。

## 7. 受け入れ基準

1. OWNERが常設IssueへURLを投稿すると、その場で処理が始まる。
2. URLなし・複数URL・危険URLは記事データを作らない。
3. 同一commentの再実行でレビューIssueを二重作成しない。
4. root / related evidence と系列媒体の独立性が既存契約どおり保たれる。
5. ledger・claim gate失敗時は非公開で、常設Issueへ安全な失敗を返信する。
6. 専用レビューで修正・却下・採用が動き、採用前はサイトへ出ない。
7. 採用後は安定URL、OGP、トップフィードのXシェア、Issue内の個別X文面が生成される。
8. 持ち込み採用で日次Xダイジェストを重複生成しない。
9. 既存の日次生成、日次レビュー、サイト、X文面のテストが後退しない。

## 8. 根拠密度型記事（2026-08-13）

持ち込み記事も、公開時の見出し・段落構成は通常生成と完全にそろえる。持ち込み専用の `detail_sections` は作らず、常に空配列にする。根拠の厚みは独自段落ではなく、通常の「何が起きた？」にあたる `what_happened` の中で確保する。

```json
{
  "detail_sections": []
}
```

- ledger claimには `editorial_role` を付ける。映画・産業記事では `key_numbers` / `policy_support` / `venue_change` / `industry_spillover`、人物記事では `personal_condition` / `working_method` / `production_support` / `daily_support` を主に使う。
- root claimが6件以上ある場合、`what_happened` は220〜650字を目安に、確認済みの独立claimを重複なく整理する。
- 重要な数字claimは原則60%以上を `what_happened` で使い、値・比較対象・時点を一緒に示す。
- 利用可能claimに明示された編集役割は最低1件ずつ使う。根拠にない役割や背景は作らない。
- 生成後に `article_depth` を計測する。独立claimの60%を使えていない、`what_happened` が短すぎる、重要数字を落とす、または独自の詳細節が残る場合は一度だけ再生成する。再生成後も不合格なら `article_too_thin` としてレビューIssueを作らない。
- 本文のclaim使用率は `what_happened` のclaim refsと実際の数値・固有名アンカーだけで計測する。注目ポイント、反応、日本向け補足のrefsで本文の厚みを水増ししない。
- 持ち込みIssueの冒頭には使用claim数、カバレッジ、重要数字claimの使用数を表示する。詳細節数は表示しない。

### 8.1 周辺根拠の取得と受け渡し（2026-08-13）

- 元URLの取得は、同一ホストの安全検査済み公開IPに対して最大3回まで再試行する。一時的な接続失敗や遅延だけで題材を失わない。URL安全検査、サイズ上限、redirect再検査は緩めない。
- 人物インタビューでは、作品名より中心人物を優先し、「人物名＋熱搜／熱議／回应／讨论」を別角度の探索語にする。本文に人民日報などの明示された元見出しがある場合は「人物名＋媒体名＋元見出し」も中心出来事の検索語に加える。
- corroboration は「中心人物＋特徴的な出来事・状態」が一致すれば候補にできる。ただし一般語（演员、作品、动态など）だけの一致は認めず、本文取得後のclaim coverageを必須にする。
- 数値集計記事は、検索結果のtitleとsnippetを候補発見にだけ使い、全文取得後に「中心数値＋イベント名＋指標」が一致した資料だけをcorroborationにする。snippet自体はclaimやevidenceにしない。
- 数値集計記事の中心数値・イベント名・指標は、LLMが返す検索語とは別に元記事から決定的に組み立て、検索語の先頭へ加える。LLMの出力揺れで中心数値を検索から落とさない。
- 新しい検索で全文検証済みcorroborationを得られなかった場合に限り、同一URLについて7日以内に保存した全文検証済みcorroborationを再利用できる。別URL、snippetだけの候補、related angle、未検証資料は再利用しない。再利用元comment idを `expansion.json` に残す。
- HTML本文は先頭selectorの長さだけで決めず、article/main、JSON-LD、埋め込みJS、meta description、bodyを採点する。本文文字数、文数、既知UI文言の比率、数値・時点アンカーを `document.json` に保存し、古いUI殻キャッシュも再利用しない。
- `related_angle` は全文検証済みの資料だけを事実台帳へ渡す。root eventの複数ソース数や裏付けには加えず、`scope=related_angle` のclaimとして分離する。確認できないSNS反応は書かない。
- 根拠密度の再生成では前回下書きを入力に残し、独立claimと重要数字を `what_happened` に整理するよう指示する。品質ゲートそのものは変更しない。
- 事実台帳のAPI通信失敗、timeout、408/429/5xx、空応答、出力打ち切り、JSON構文不良は同じ根拠とschemaで1回だけ再試行する。台帳の件数不足や根拠不足はこの再試行対象にせず、既存のadequacy gateで判定する。持ち込みでは台帳失敗後に根拠参照のない汎用summaryへ進まず停止する。
- 台帳再試行が尽きた場合は、本文・prompt・provider応答を保存せず、provider、model、試行数、失敗段階、原因コード、HTTP status、finish reason、応答文字数、所要時間だけを `ledger-extraction.json` に残す。
- 公開ページ、レビューIssue、レビューUIのすべてで通常記事と同じ段落構成を使う。持ち込みも `detail_sections: []` とする。

基準ケース:

- 映画市場記事: 興行・票価、12億元の補助金、映画館・スクリーン増と複合化、3800億元の産業チェーンと周辺消費への波及を、追加見出しを作らず `what_happened` で読めること。
- Issue #34型の人物記事: 現在の状態、本人の演技方法、撮影側の合図、日常の文字起こし手段を、追加見出しを作らず `what_happened` で読めること。

