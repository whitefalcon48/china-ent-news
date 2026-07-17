# X bot 運用手順（半手動 → 自動）

最終更新: 2026-07-17。段階導入の方針: **まず半手動**（生成文面を人が X の予約投稿に保存）で品質を確認し、
担保できてから自動投稿（`X_POSTING_ENABLED=true`）へ切り替える。

文面の設計正本は `docs/design-phase4-site.html` §3（機械組み立てのみ・ハッシュタグなし・絵文字はキャラ1つまで）。
生成コードは `src/site/postToX.ts`（日次ダイジェスト）と `src/site/xPostTexts.ts`（個別投稿候補・出力 Markdown）。

## 0. 事前準備（初回のみ・ユーザー作業）

- [ ] X アカウント作成: ハンドル `@bingtang_chan`（仮置き）の空きを確認して作成。
      アイコン・ヘッダーは Phase 4a の公開用素材が揃うまで仮でよい
- [ ] プロフィールにサイト URL（`https://<owner>.github.io/china-ent-news/`）を固定リンクとして設定
      （個別投稿は URL を含めないため、誘導はこのリンクが担う）
- 半手動フェーズでは **X API キー・Developer 設定は不要**（費用ゼロ）

## 1. 半手動フェーズの毎朝の手順

1. generate-news ワークフロー（毎朝 JST 10時台に自動実行）の完了を待つ
2. GitHub → Actions → 当日の実行 → **Summary 画面**を開く。
   「X投稿文面 YYYY-MM-DD」として日次ダイジェストと個別投稿候補が字数付きで表示される
   （同じ内容が artifact `x-post-texts` にもある。ローカルなら `npm run post:x` の dry-run でも生成可能）
3. 日次ダイジェストをコピー → X Web（PC）の投稿画面に貼付け → **予約投稿**（または下書き保存）
4. 個別投稿候補から出したいものを選んでコピー → 同様に予約投稿（テキストのみ・URL は付けない）
5. 下記チェックリストで文面を確認。問題があれば投稿前に手直しし、**手直し内容を記録**する

## 2. 品質チェックリスト

- [ ] 元記事（サイトの該当記事）にない情報が文面に混ざっていないか（捏造ゼロの確認）
- [ ] 見出し・リードの切り詰め（…）が不自然な位置で切れていないか
- [ ] ダイジェストのリンク先 `archive/YYYY-MM-DD/` が実際に開けて当日分が表示されるか
- [ ] 本文がです・ます＋「ね」「よ」語尾（ビンタン確定声）になっているか
      ※文面は title_ja / lead の機械組み立てなので、崩れていたら生成パイプライン側の問題
- [ ] ハッシュタグが入っていないか／絵文字がダイジェストの 🧊👇 以外に増えていないか
- [ ] 字数表示が 280 以内か（超過時はスクリプトが throw するので通常は起きない）

手直しが数日続けて同じパターンで発生する場合は、テンプレ側（`xPostTexts.ts` / `buildDigest`）を
調整する（設計確定済みの範囲なので下位モデルで実装してよい）。

## 3. 自動化への切り替え（品質担保後・ユーザー作業）

1. **X API 課金の一次確認**: X Developer Portal で単価を確認する
   （設計前提: URL 付きポスト $0.20/本・テキストのみ $0.015/本 — 第三者情報のため要確認。
   前提と大きく違う場合はリンク戦略を再検討してから進む）
2. 既存の Developer アカウントに新規プロジェクト/アプリを作成（@bingtang_chan で認可すること）
   - User authentication settings: OAuth 1.0a / App permissions **Read and write**
   - API Key & Secret、Access Token & Secret（Read and write で再生成）の4種を控える
3. GitHub リポジトリ → Settings → Secrets and variables → Actions に登録:
   `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`
4. 同 → Variables に `X_POSTING_ENABLED` = `true` を作成
   （これが自動投稿のオン/オフスイッチ。`true` 以外なら dry-run チェックのみで投稿されない）
5. `workflow_dispatch` で generate-news を手動実行し、初回の実投稿（ダイジェスト1本）を確認
6. X のアカウント設定で **automated account ラベル**を付与（運営アカウントとの紐付け）
7. 個別投稿の自動化（4b・テキストのみ最大10本/日）は、半手動での品質実績を見てから判断

## 4. 緊急停止

- 自動投稿を止める: リポジトリ Variables の `X_POSTING_ENABLED` を `false` に変更（即時有効・次回実行から）
- 文面生成自体は止まらないので、半手動運用にいつでも戻せる
