# 2026-09-06 承認済みノートデザイン

ユーザーが比較プレビューv3を承認し、公開を指示。見た目の現行仕様は本書を優先する。キャラクターの正本は character-bingtang-v2.md、編集内容の正本は editorial-character.md。

- 薄い氷青の方眼背景、白いノート、赤い背表紙とリング。赤はロゴ・ナビ・ノートの縁・フッターに使う。
- 最新／アーカイブ／このサイトについて、および日付見出しはノートの外。日付スタンプやヘッダーの台詞・タグラインは置かない。
- ロゴ4文字は同じ Noto Sans SC Black の字形で統一。日本語読みは「ビンタンちゃんデイリー」。
- 右手を上げた大きなビンタンちゃんを右上に配置。衣装も見せ、透過背景で最初のノートに少し重ねる。
- 本文、出典、タグ検索、記事URL、公開済みスナップショット、公開承認ルールは維持。

## 素材

- docs/assets/site/bingtang-header-wave-transparent.webp: V2正本を参照して生成しユーザー承認された派生イラスト。周縁背景を除去し、白い衣装を残した透過WebP。730px幅。
- docs/assets/site/bingtang-logo-black.ttf: Google Fonts Noto Sans SC Black、冰糖日报4文字の配信サブセット。SIL OFL 1.1。ライセンスは隣の bingtang-logo-LICENSE.txt。
- src/site/notebook.css: 公開用CSS。build.tsで assets/notebook-v1.css にコピーし、ドメイン直下・GitHub Pagesサブパス両方に対応。

## 確認

型チェック、site-feed、publication-flowが成功。実データ80 HTMLページのarticle要素は変更前後で完全一致。375pxとデスクトップの表示、ロゴフォント読込み、画像読込み、横はみ出しなし、アーカイブのNetflix検索を確認。
