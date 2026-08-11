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
- source expansionが0件でも、seed記事だけで台帳とclaim gateを通る狭い記事案はレビューへ出せる。存在しない反応・背景は補わない。
- `summarizeTopic` が実際に使用したledgerを標準形式で保存し、修正再生成にも同じledgerを使う。
- ledger欠落またはgated violationがある場合はレビューIssueを作らない。

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

