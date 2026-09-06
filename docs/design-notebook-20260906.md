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

## OGP（2026-09-06・②採用、画質調整プレビュー）

1200×630。ごく薄いピンクの背景、白いカード、紺の統一ロゴ、右端と短いラインだけ赤。右側に氷青の円と大きな透過ビンタンを配置し、衣装は画像下端につなげる。トップはロゴ主体、固定ページはページ名、記事は見出しを最大5行で表示する。訃報等では既存の真剣な表情を使用する。記事本文・投稿文面・公開承認状態は変更しない。

画質調整素材: docs/assets/site/bingtang-ogp-wave-clean.webp。built-in image_gen で元イラストの輪郭と塗りを整えた。出力の背景模様は周縁から除去し、衣装の白は保持。元のサイトヘッダー画像は別素材として維持。

使用プロンプト: Edit target: supplied Bingtang character cutout. Precise cleanup / identity preservation. Preserve character, face, happy smile, ruby-red eyes, ice-blue bob with red inner hair, curved ahoge, white headphones with translucent red candy panels, raised anatomical right hand, white Chinese dress, red frog closures, waist bow, tassels and ice-blue panel. Remove fuzzy ragged edges, gray halo, gritty speckles, patchy watercolor noise and broken lines. Smooth continuous thin anime ink lines, crisp cel shading, clean white fabric with cool-gray shadow shapes. Do not blur or redesign. Transparent alpha background, no text or shadow. Include complete ahoge and hand, upper body through waist and mid-skirt.

ユーザーが画質調整版を承認し、実装を指示。OGP生成へ組込み、ローカル検証済み。
