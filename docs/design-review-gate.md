# 設計: 人間レビューゲート（出力安定までの公開監督フロー）（Fable 設計セッション 2026-07-18）

出力品質が安定するまで、毎日の生成結果を運営者（Falさん）が「採用／修正して再チェック／却下」に仕分けてから公開する運用ゲートを導入する。却下・修正の理由はタグ付きで蓄積し、選定ロジック・プロンプトの改訂判断に使う。ユーザー決定事項（2026-07-18）: ①レビューUIは GitHub Issue コメント方式 ②「修正」はコメント付き再生成 ③レビュー完了までサイトは全記事保留（未判定日はサイト据え置き）。Phase 3b（design-phase3b-reader-first-quality.md）とはコード面で独立しており、先行導入・並行実装が可能。X 自動投稿（X_POSTING_ENABLED）を有効化する前に本ゲートを入れる。

## 1. 全体フロー

```
毎朝: generate-news（既存Actions）
  → pipeline実行 → data/YYYY-MM-DD/ コミット（従来どおり）
  → review.json を「全記事 pending」で作成・コミット
  → サイトビルドは「レビュー完了日」だけを含める（当日分はまだ出ない）
  → GitHub Issue「📋 ニュースレビュー YYYY-MM-DD」を自動作成（label: daily-review）

日中: Falさんが Issue に判定コメントを1つ返す（スマホ可・pull/push不要）

自動: review-apply（新規Actions、issue_comment トリガ）
  → コメントをパースして review.json 更新
  → 却下/修正の理由を data/review-feedback.jsonl に蓄積
  → 「修正」記事は保存済み fact ledger から再生成し、Issueに再掲（再判定待ち）
  → 全記事の判定が確定したら: 承認記事のみでサイトビルド → Pages デプロイ
    → X 投稿文面を承認分のみで再生成（Actions Summary へ・半手動運用は継続）
    → 結果サマリをコメントして Issue をクローズ
```

## 2. 設計判断（R-D1〜R-D8）

- **R-D1 Issue = レビューUI**: Issue 本文に記事全文（見出し・リード・本文・ビンタンコメント・ソース）を展開し、判定は返信コメント1つで完結させる。追加のWebアプリ・バックエンドは作らない。GitHub モバイルアプリで完結する。
- **R-D2 判定はコメント文法で受ける**: 行ベースの単純文法（§4）。パース不能行は bot がエラー返信で指摘し、正しい行だけ適用する（全体を失敗させない）。同じ番号への後のコメントが前の判定を上書きする。
- **R-D3 「修正」= コメント付き再生成**: 手動編集ではなく、保存済み fact ledger（data/YYYY-MM-DD/fact_ledger_*.json）から該当記事だけ再生成する。再収集・再選定はしない。修正指示は禁止事項より弱い優先度でプロンプトに注入する（§6）。再生成後は同じ番号で再判定に戻る（revision_count を記録、上限3回。超えたら自動で却下扱いにせず pending のまま Issue に警告を出す）。
- **R-D4 公開は全記事確定後**: 全記事が approved / rejected のいずれかに確定した時点で、承認分のみサイトに公開。未判定の日はサイトが前回完了日のまま。承認0本の日は既存の空状態表示（0件日ハンドリングは Phase 4a 実装済み）。
- **R-D5 却下理由は構造化して蓄積**: 理由タグ（選定／口調／用語／事実／構成／その他）＋自由記述。feedback レコードには選定メタデータ（seed_confidence・topic_type・score・priority・selection_reason・source_mix）を同梱し、後の集計が trace との突き合わせなしで完結するようにする。タグは Phase 3b 原因分析の5分類と対応（選定=1-E、口調=1-A、用語=1-B、事実=1-C/1-D、構成=その他）。
- **R-D6 ロジック更新は自動化しない**: feedback の蓄積を `npm run report:feedback` で集計し、改訂判断は人間＋モデルセッションで行う。目安: 選定タグ多発→ゲート/スコア調整（Codex 可）、口調・用語タグ多発→プロンプト改訂（Fable 案件、AGENTS.md の振り分け指針どおり）、事実タグ→claimCheck 強化。単発の却下から即ロジックを変えない。
- **R-D7 セキュリティ**: review-apply はコメント投稿者の author_association が OWNER の場合のみ動作。それ以外のコメントは無視（返信もしない）。ワークフロー permissions は contents: write / issues: write の最小構成。
- **R-D8 脱出ハッチ**: workflow env `REVIEW_GATE=false` で従来の即時公開に戻す（Issue 作成・レビューフィルタを全てスキップ）。切り戻しはワークフローの env 1行。

## 3. Issue 本文フォーマット（確定形）

```markdown
# 📋 ニュースレビュー YYYY-MM-DD（N本）

判定はこのIssueへの返信コメントで。1コメントにまとめて書けます。

- `<番号> 採用`
- `<番号> 却下 <理由タグ> <コメント>`
- `<番号> 修正 <理由タグ> <修正指示>`
- `残り採用`（未判定をすべて採用）
- 理由タグ: 選定 / 口調 / 用語 / 事実 / 構成 / その他

---

## 1. 【badge｜カテゴリ｜確度】タイトル
（lead）

（what_happened）

**ビンタンの注目ポイント**: （why_it_matters）

**ひとこと**: （editor_comment）

ソース: （source_list）

---

## 2. …
```

（記事部分は data/YYYY-MM-DD/ の articles JSON から機械組み立て。番号は articles JSON の並び順と一致させる）

## 4. コメント文法（確定形）

- 1行1判定。正規表現: `^(\d+)[\s　]+(採用|却下|修正)(?:[\s　]+(選定|口調|用語|事実|構成|その他))?(?:[\s　]+(.*))?$`
- `残り採用` / `全部採用`: 未判定（pending / revised_pending）をすべて採用
- `残り却下 <理由タグ> <コメント>`: 未判定をすべて却下
- 却下・修正で理由タグ省略時は「その他」として扱う
- 同一番号に複数判定がある場合は最後の行（および後のコメント）が有効
- パース不能行は bot が「⚠️ 解釈できなかった行」としてまとめて返信。解釈できた行は適用する

## 5. データスキーマ

`data/YYYY-MM-DD/review.json`:

```json
{
  "date": "YYYY-MM-DD",
  "status": "pending | completed",
  "issue_number": 0,
  "articles": [
    {
      "index": 1,
      "topic_key": "",
      "title": "",
      "status": "pending | approved | rejected | revision_requested | revised_pending",
      "reason_tag": "",
      "comment": "",
      "revision_count": 0
    }
  ]
}
```

`data/review-feedback.jsonl`（1行1レコード・追記のみ）:

```json
{ "date": "", "topic_key": "", "action": "rejected | revision_requested", "reason_tag": "選定", "comment": "", "category": "", "topic_type": "", "seed_confidence": 0, "newsworthiness_score": 0, "publish_priority": "", "selection_reason": "", "source_mix": {} }
```

## 6. 修正再生成の設計

- 入力: data/YYYY-MM-DD/fact_ledger_*.json の該当 topic の台帳（fallback だった記事は台帳が null のため、その場合は articles JSON 内の evidence 情報で現行の単段プロンプトを使う）
- 再生成範囲: 理由タグが「口調」かつコメント分離工程（Phase 3b B7）実装済みの場合はコメント工程のみ再生成（1呼び出し）。それ以外は台帳からの執筆＋（3b実装済みなら）コメント工程を再実行（1〜2呼び出し）。3b 未実装の間は常に既存 buildLedgerWritingPrompt での再生成（1呼び出し）
- 再生成後も claimCheck（および 3b 実装後は comment check・terminology 置換）を通常どおり通す
- プロンプトへの注入文（確定形。執筆／コメントプロンプトの末尾に付ける）:

```text
運営者（Falさん）からの修正指示があります。次の指示を反映して書き直してください:
<修正コメント>
ただし、事実台帳に無い情報を足さないこと・禁止事項を破らないことを最優先し、指示がこれらと矛盾する場合は矛盾しない範囲でのみ反映してください。
```

- 再生成結果は data の articles JSON を更新し、Issue に「🔄 修正版 <番号>」としてフォーマット済み記事を返信コメントで再掲 → status を revised_pending に戻す
- 再生成の LLM 失敗時: 記事は元のまま、Issue に失敗を返信（pending 維持。graceful fallback）

## 7. ワークフロー設計

### generate-news（既存の生成ワークフローに追記）

- pipeline 完了後: review.json（全記事 pending）を生成・コミット
- Issue 作成: gh CLI で本文（§3）を投稿、label `daily-review` を付与、issue_number を review.json に書き戻す
- サイトビルド: レビューフィルタ（§8）を適用してビルド・デプロイ（当日分は含まれない）
- X 投稿文面の生成ステップは「レビュー完了時」（review-apply 側）へ移動
- `REVIEW_GATE=false` の場合は上記をすべてスキップし従来挙動

### review-apply（新規 `.github/workflows/review-apply.yml`）

- trigger: `issue_comment` (created)。条件: Issue に `daily-review` ラベル && `github.event.comment.author_association == 'OWNER'`
- 処理: コメントをパース → review.json 更新 → 却下/修正を feedback.jsonl へ追記 → 修正対象を再生成（DEEPSEEK_API_KEY 使用）→ コミット（`git pull --rebase` 後に push、失敗時1回リトライ）
- 全記事確定時: 承認分のみでサイトビルド → Pages デプロイ → X 投稿文面を承認分で生成し Actions Summary と artifact に出力 → 結果サマリ（採用N・修正N回・却下N＋タグ内訳）を返信 → Issue クローズ、review.json の status を completed に
- permissions: `contents: write` / `issues: write` / Pages デプロイに必要な既存 permissions を踏襲

## 8. サイトビルドの変更（src/site/build.ts）

- ビルド対象日の決定時に review.json を参照: `status: "completed"` の日だけを含め、記事は `approved` のみ、review.json の並びで index を振り直す
- review.json が存在しない日（ゲート導入前の過去日）は従来どおり全記事を含める（後方互換）
- `REVIEW_GATE=false`（ビルド時 env）でフィルタ無効化

## 9. graceful fallback 一覧

| 障害 | 挙動 |
|---|---|
| コメントのパース不能行 | 解釈できた行だけ適用し、不能行をまとめて返信 |
| 修正再生成の LLM 失敗 | 記事は元のまま pending 維持、Issue に失敗返信 |
| revision_count 上限（3回）超過 | pending のまま Issue に警告（自動却下しない） |
| Issue 作成失敗 | generate-news は失敗させず警告ログ。`npm run review:issue` で手動再作成できるスクリプトを用意 |
| review.json 不在の過去日 | 従来どおり全記事公開（後方互換） |
| push 競合 | pull --rebase → リトライ1回 → 失敗時はワークフロー失敗（データ破壊しない） |
| オーナー以外のコメント | 無視（返信もしない） |

## 10. 実装手順（R1〜R7。各ステップ後に `npm run check`）

- **R1** `src/review/reviewState.ts`（新規）: review.json スキーマ型・読み書き・pipeline 末尾での初期生成。types.ts に型追加
- **R2** `src/site/build.ts`: レビューフィルタ（§8）＋ REVIEW_GATE ハッチ。受け入れ: ダミー review.json で approved のみ・completed 日のみが出る
- **R3** `src/review/buildReviewIssueBody.ts`（新規）＋ generate-news ワークフロー追記: Issue 自動作成。`npm run review:issue` 手動再作成スクリプト。受け入れ: ダミー articles JSON から §3 形式の本文が生成される
- **R4** `src/review/parseReviewComment.ts`（新規・純関数）: §4 文法。受け入れ: 採用/却下/修正/残り採用/タグ省略/不能行のダミーテストが通る
- **R5** `src/review/applyReview.ts`（新規）＋ `.github/workflows/review-apply.yml`（新規）: 状態更新・feedback.jsonl 追記・完了判定・公開トリガ・サマリ返信・クローズ
- **R6** `src/review/reviseArticle.ts`（新規）: §6 の再生成＋Issue 再掲。受け入れ: ダミー台帳＋修正指示で再生成プロンプトに注入文が入る
- **R7** `src/qualityReport.ts` に `npm run report:feedback` を追加（または独立スクリプト）: タグ別・カテゴリ別・seed_confidence 帯別の集計。roadmap 更新・コミット

## 11. 受け入れ基準

1. 毎朝、記事全文入りのレビュー Issue が自動作成される
2. 返信コメント1つで複数記事の判定が review.json に反映される
3. 却下・修正の理由が選定メタデータ付きで feedback.jsonl に蓄積される
4. 修正指示で該当記事だけが再生成され、Issue に再掲されて再判定できる
5. 全記事確定で承認分のみが Pages に公開され、Issue が自動クローズされる
6. 未判定の日はサイトが前回完了日のまま変わらない
7. オーナー以外のコメントでは何も起きない
8. パース不能行がエラー返信で指摘され、正しい行は適用される
9. `REVIEW_GATE=false` で従来の即時公開に戻る
10. `npm run report:feedback` でタグ別・カテゴリ別集計が出る

## 12. 検証手順

1. 各ステップ後 `npm run check`
2. parseReviewComment / reviewState / ビルドフィルタは scratchpad のダミーデータで検証（コミットしない）
3. リハーサル: テスト用日付で generate-news を手動実行 → 実 Issue でコメント判定 → 承認分のみ公開されるか・Issue クローズまでの一連を確認
4. REVIEW_GATE=false での従来挙動確認
5. 数日運用後、report:feedback の集計が Phase 3b の受け入れ判定（口調・用語・選定）の実測材料として使えることを確認

## 13. 運用ルール（ロジック更新ループ）

- 週1目安で `npm run report:feedback` を確認
- 選定タグ多発 → 情報完全性ゲート・スコアの調整（設計済みの範囲は Codex 可）
- 口調・用語タグ多発 → プロンプト改訂（⚠️ Fable 案件。AGENTS.md 振り分け指針 1・3 に該当）
- 事実タグ → claimCheck の正規化・ルール追加
- 却下1件だけで即ロジックを変えない。傾向（同タグ3件以上目安）で動く
- 出力が安定したら（目安: 2週間連続で却下0〜1本/日）、ゲートを外すか判断する

## 14. やらないこと

- 却下理由からの自動ロジック変更（集計→人間判断のみ）
- レビュー専用 Web アプリ・バックエンド
- X 自動投稿の有効化（従来どおり半手動。文面生成タイミングの移動のみ）
- Phase 3b 本体（design-phase3b-reader-first-quality.md）の変更
- 再収集・再選定を伴う修正（再生成は保存済み台帳からのみ）
