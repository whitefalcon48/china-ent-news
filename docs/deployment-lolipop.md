# ロリポップ本番配信

本番URLは `https://bingtangnews.0-w-0.net/`。既存の `0-w-0.net` 配下サイトとメールのDNSを変更せず、静的ビルドをロリポップの `bingtangnews` 公開フォルダへ明示的FTPSで配信する。

## 配信構成

- 本番: `dist/lolipop-site`（`SITE_URL=https://bingtangnews.0-w-0.net`、ベースパスなし）
- フォールバック: `dist/site`（`https://whitefalcon48.github.io/china-ent-news/`、ベースパス `/china-ent-news`）
- 配信対象ワークフロー: `deploy-site.yml`、`generate-news.yml`、`review-apply.yml`
- 3ワークフローは `china-ent-news-production` concurrency group で直列化する

## GitHub Secrets

`github-pages` environment またはリポジトリに、次のSecretsを登録する。値はログやコードへ書かない。

- `LOLIPOP_FTPS_HOST`: ユーザー専用ページのFTPSサーバー
- `LOLIPOP_FTPS_USER`: FTP・WebDAVアカウント
- `LOLIPOP_FTPS_PASSWORD`: FTP・WebDAVパスワード

## 安全策とロールバック

- `scripts/deploy_lolipop.py` はTLS証明書を検証し、パッシブモードで接続する。
- リモートの既存ファイルは削除せず、生成物だけを上書きする。
- 画像・CSS・下位ページを先に送り、ルート `index.html` を最後に更新する。
- 通信失敗は3回まで再試行し、全失敗時はワークフローを失敗させる。既存の公開内容は残る。
- 本番障害時はGitHub Pagesのフォールバックを確認し、必要なら案内先を一時的に戻す。
