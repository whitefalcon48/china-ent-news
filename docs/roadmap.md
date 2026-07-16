# ロードマップ & 引継ぎ指針

最終更新: 2026-07-16（Phase 4a UI差分設計の完了時点）

## ゴール像

参考イメージ: https://news.nullevi.app/

- 「記事の羅列」ではなく「出来事・論点」単位のトピックが並ぶ
- 1トピックに 公式 / 媒体 / SNS / データ の複数ソースタイプが紐づく
- 公式だけで完結するトピックは低評価、クロスソースのトピックが高評価
- 最終出力は人間が見る「今日確認すべきトピック候補」リスト
- 「なぜ今この話題か」「日本語圏で見えにくい理由」が拾えている

編集方針の正本は `docs/editorial-character.md`。

## フェーズ状況

### Phase 1: 供給の修理 + スコア反転 — ✅ 完了（2026-07-06）

実測結果（selection_trace / source-audit 2026-07-06）:

- 候補プールの官庁比率: 70% → 31%
- 媒体ソースの fresh 記事: 1件 → 34件（新浪8・新京报19・1905 6・界面1）
- official-only topic の priority: 26/32件が low に反転
- 最終出力（DeepSeek/Actions）: 媒体6本＋公式4本の混合、ゴシップ・業界・文化の幅が出た

主な変更: エンタメキーワードゲートを reliability A + オプトインのみに限定、
新浪の `k.sina.com.cn/article_` 解禁、微博热搜 fetcher（`src/fetchHotSearch.ts`）、
official-only 減点(-15)と备案ボーナス削除、`src/topicKey.ts` への一本化。

### Phase 2: topic-first 化 + source expansion — 🔜 次

決定済みの技術方針（2026-07-06 ユーザー確認済み）:

- 検索手段は **RSSHub 先行 → 限界が見えたら検索 API（Serper 等）追加** の二段構え
- topic seed 抽出は **LLM バッチを採用**（DeepSeek、1実行あたり呼び出し1〜2回増）
- 日本語圏可視性は **当面ヒューリスティック改良のみ**（実測は検索 API 導入後）

タスクは番号順に実施。各タスクは独立に完結し、受け入れ基準を満たしてから次へ。

#### 2-1. LLM topic seed 抽出（新規 `src/topicSeeds.ts`）— ✅ 完了（2026-07-06）

- 収集記事の title+excerpt を LLM バッチ1回で変換:
  出来事文（例:「国家广电总局から今季の电视剧・网络剧备案が公示された」）+ entities + 検索クエリ案(中国語2〜3個)
- regex `createTopicKey`（`src/topicKey.ts`）はフォールバックとして残す
- LLM 失敗時は全体を止めず regex キーで続行（graceful fallback）
- **受け入れ基準**: topic_candidates の topic_key から「达再合作」「演唱会高」型の壊れたキーが消える。
  同一出来事の別タイトル記事（あれば）が同一 seed に束なる
- ⚠️ **プロンプト初版の設計は Fable に依頼推奨**（後述の振り分け指針）
- 完了メモ:
  `src/topicSeeds.ts` を追加し、LLMバッチ抽出 + regex fallback を実装。
  `topic_candidates` に `topic_seed_extraction` / `event_sentence` / `search_queries` / `seed_source` / `seed_confidence` を出力。
  ローカルGeminiは timeout のため fallback 経路で確認し、壊れた topic_key 0件、同一作品・映画祭・ドラマの複数記事クラスタを確認済み。

#### 2-2. source expansion 骨格（新規 `src/expandSources.ts`）— ✅ 完了（2026-07-06）

- topic seed の検索クエリで追加ソースを収集する fetcher インターフェースを定義
- 第1実装: RSSHub ルート（微博検索 `/weibo/search/…`・豆瓣・B站）。全ルート graceful fallback
- 取得結果は sourceType 別に topic の evidence_articles へ紐付け
- 上位 seed（スコア順 N 件）だけ expansion して呼び出し数を制御
- **受け入れ基準**: selection_trace に expansion の試行/成功/失敗がルート別に出る。
  成功時に source_count>=2 の topic が発生する
- 未解決課題: 公開 rsshub.app はローカル/Actions 双方でタイムアウト実績あり。
  ミラー・自前 RSSHub・`RSSHUB_BASE_URL` 差し替えを最初に実測すること
- 完了メモ:
  `src/expandSources.ts` を追加し、RSSHub route template ベースの fetcher interface を実装。
  `selection_trace.source_expansion` と `topic_candidates.source_expansion` に route別の試行/成功/失敗を記録。
  2026-07-06 ローカル実測では公開 `rsshub.app` の weibo / douban / bilibili 3ルート x 上位3topic がすべて timeout。
  外部通信なしのモックRSSで、成功時に追加 evidence が topic に紐づき `source_count=2` / `has_multiple_sources=true` になることを確認済み。

#### 2-3. topic-first 生成（選定単位を記事 → topic へ）— ✅ 完了（2026-07-12、品質課題は 2-3b へ）

- `src/index.ts` の選定を topic 単位に切替、`summarizeArticle` → `summarizeTopic`
  （topic の evidence 束＝公式+媒体+SNS+データを1プロンプトに渡し1本のメモを生成）
- カテゴリ/ソース上限ロジックは topic 属性ベースに移植
- **受け入れ基準**: 出力 Markdown の1記事に複数ソースリンクが並ぶ。
  1ソース topic では複数視点を捏造しない（既存の禁止事項を prompt に維持）
- ⚠️ **summarizeTopic プロンプト初版と選定ロジックの設計レビューは Fable に依頼推奨**
- ✅ **設計完了（Fable 2026-07-06）**: `docs/design-2-3-topic-first.md` に
  プロンプト初版・選定設計・実装手順・検証手順を記載。実装はこの文書に沿って進める。
  設計時の発見: SNS単独ジャンク topic がスコア100で最上位に来る問題 → 設計に上限ガード込み
- 実装メモ（2026-07-12）:
  topic-first 選定・evidence 最大4件・`summarizeTopic`・topic selection trace・`TOPIC_FIRST=false` 脱出ハッチを実装。
  ローカル実測は 100 topic → 8選定、複数ソース topic 2件（`功夫女足` / `上海国际电影节`）。
  候補プール官庁比率 32%（前回31%）、媒体 fresh 38件（前回34件）で後退なし。
  SNS単独のスコア100入力が上限55・priority lowになること、単一 evidence では
  `has_multiple_sources=false` / 非SNSの `reaction_view` 空補正になることをモック確認。
  GitHub Actions(deepseek) の Markdown 受け入れ確認は、未pushコミットを実行できないため未実施。
- Actions 実測（2026-07-12）: 受け入れ基準は達成（功夫女足=3ソース束、给阿嬷=2ソース束、単一ソースの捏造なし）。
  一方で品質問題が発生（映画偏り・官製文化イベント混入・分析記事混入）→ 原因分析済み、**2-3b で修正**

#### 2-3b. 品質修正パッチ — ✅ 完了（2026-07-12、残課題は 2-3c へ移管）

- 設計・実装指示: `docs/design-2-3b-quality-fixes.md`（F1〜F8）
- 主な内容: ①topic seed LLM 抽出のバッチ分割（**本番で一度も成功していなかった**JSON切断の修正）
  ②AI段階で消えた topic の backfill + trace 可視化 ③カテゴリ判定順の修正（映画が芸能/業界枠を食う問題）
  ④官製文化イベント低優先度化＋音楽の大衆ポップス判定 ⑤分析記事の skip 強化（プロンプト文言は設計文書に確定済み）
  ⑥Serper 検索 fetcher（2-5 前倒し。RSSHub 全滅時のみ発動、無料枠節約設計）
  ⑧カテゴリ上限の再設計（主要5カテゴリ各2・海外映画祭/その他の予約席廃止・ポップスは芸能へ・最終補充パス）
- ユーザー決定済み: 音楽=低優先度方式 / Serper 今導入 / カテゴリ上限は5カテゴリ各2（2026-07-12）
- ユーザー作業: Serper.dev のキー取得 → GitHub Secrets に `SERPER_API_KEY` 登録
- **受け入れ基準**: 設計文書の検証手順（seed llm≥8割 / 出力の多様性回復 / 管乐・分析記事型の排除 / expansion success>0）
- 実装メモ（2026-07-12）:
  F1〜F6・F8を実装。seedは25件チャンク、AI失敗時の同カテゴリbackfillとtrace、映画判定順、
  官製文化イベント上限55、分析記事skip、RSSHub全失敗時のみSerper、主要5カテゴリ各2＋最終補充を反映。
  合成検証は60記事→3チャンク・全件LLM、1チャンク失敗時は35件LLM＋25件fallback。
  ローカル実測は初期8 topicで映画2・ドラマ1・芸能1を維持、`final_fill` 2件。
  API未設定によるAI失敗でbackfill 8件、`failed` / `backfilled` traceを確認。
  管乐展演型は score 55 / priority low で未選定。媒体 fresh は38件を維持。
  SerperはモックでRSSHub 3失敗→success 1件、未設定時は `not_configured` を確認。
  Actions(deepseek) の seed llm比率・最終Markdown多様性・実Serper successは未pushのため確認待ち。
- Actions 実測（2026-07-12）: seed 98/98 が LLM 抽出、最終出力の映画は 9本中4本で過半数を下回り
  ドラマ・音楽・アニメ・政策が残った。backfill 6件動作、複数ソース表示も維持。受け入れ基準達成。
  残課題（管乐展演が LLM 後に medium 復活・7 topic が理由 unknown で post-AI 除外・
  公式ソース2本の URL 欠落・Serper `not_configured` 3回）は **2-3c で修正**

#### 2-3c. hotfix（priority クランプ / unknown 除外 / URL 復元 / Serper 実測）— 🟡 実装・ローカル検証完了 / Actions待ち（2026-07-13）

- 実装指示: `docs/design-2-3c-hotfix.md`（H1〜H5）。全項目 Fable がコード上で根本原因を確認済み
- H1 publish_priority の事前判定クランプ / H2 backfill の low priority ガード /
  H3 post-AI unknown 除外の救済と trace 理由の明確化 / H4 source_list URL の内部メタデータ復元 /
  H5 `SERPER_API_KEY` 登録（ユーザー作業）+ Actions 実測
- ⚠️ は無し（設計確定済みのため Codex / 下位モデルで実装してよい）
- **受け入れ基準**: 管乐展演型が low のまま backfill でも出ない / post-AI 除外理由に `unknown` が無い /
  出力 Markdown の全ソースにリンク URL / expansion success > 0
- 実装・ローカル実測（2026-07-13）: H1〜H4を実装。候補98件、官庁比率32.7%、媒体fresh 38件、
  複数ソースtopic 3件（前回ローカル3件）を維持。post-AI除外理由 `unknown` 0件。
  AI失敗時は初期8件からbackfill 7件を試行し、非low 5件を先に採用後、lowは1件のみ
  （選定済みlowとの合計2件、上限3件以内）。事前lowの最終priority固定とURL復元はモック確認済み。
  H5およびH1/H4の実DeepSeek確認は、ユーザーによるpush後のActions実測待ち。

#### 2-4. 出力の再定義「今日確認すべきトピック候補」— ⏩ Phase 3a に吸収（2026-07-13 決定）

- 最終出力を publish_priority 順 + source_mix 表示 + official-only は低評価明示のリストに
- **受け入れ基準**: Markdown を見て「今日どの話題を確認すべきか」が1分で判断できる
- Phase 3a の renderMarkdown 改修（`docs/design-phase3a-fact-ledger.md` L4）として実施する

#### 2-5. 検索 API 導入 — ⏩ 2-3b に前倒し統合（2026-07-12 決定）

- 公開 RSSHub がローカル・Actions とも全滅（http_error 9/9）したため発動条件成立。
  Serper を採用し、実装は `docs/design-2-3b-quality-fixes.md` の F6 として実施
- **受け入れ基準**: RSSHub 失敗時も expansion が成立する
- 実装メモ（2026-07-12）: Serper fetcherとドメイン別source_type判定を実装済み。
  モックでfallback成立を確認。実APIは `SERPER_API_KEY` 登録後のActions確認待ち。

#### 2-6. 日本語圏可視性の実測（2-5 の後）

- 上位 topic のみ日本語検索し japan_visibility を実測に置換

### Phase 3: 内容ブラッシュアップ（生成パイプライン再設計）— 設計確定（2026-07-13）

方向確定の記録: `docs/design-phase3-content-pipeline.md`（Fable 検証済み）。

1. ✅ **Fable 設計セッション**（2026-07-13 完了）: 残項目1〜5を確定し、
   追加要件（秘書見出し・少女口調・用語解説・日本公開情報の記載規定・帰属規定・
   给阿嬷「日本未公開」誤記の再発防止）を反映。
   **Phase 3a の Codex 実装指示書 = `docs/design-phase3a-fact-ledger.md`**（L1〜L11）
2. 🟡 **Phase 3a — 実装完了・Actions待ち（2026-07-13）**: 事実台帳の抽出 + 台帳からの執筆（2段階化）+ 機械検査（ゲート2種+warning記録）
   + renderMarkdown 改修（2-4 吸収）。⚠️ は無し（設計確定済みのため Codex で実装してよい。
   ただしプロンプト文言は design-phase3a に確定済み・変更しない）
   実装・ローカル実測: L1〜L11を実装しcheck・claimCheck/renderダミー検証成功。候補99件、官庁32.3%、媒体fresh 38件、複数ソースtopic 3件、trace予算 limit 45 / used 0（APIキーなしのため台帳・出力0件、Actions確認待ち）。
3. **Phase 3b**: 秘書コメント分離 + warning 検査のゲート化判断（trace 観察後）
4. **Phase 3c**: analysis_feature 解禁（editorial-character.md 改訂・F5 supersede・1本/日上限）

各段で Actions 実測を挟み、官庁比率 ≦ 50% / 媒体 fresh > 0 / 最終本数・複数ソース topic 数の
後退がないことを確認してから次へ。
前提: 2-3c の Actions 実測（`SERPER_API_KEY` 登録込み）を 3a 着手前に完了させること。

### Phase 4: サイト化 + X bot 化 — 設計完了・実装未着手（2026-07-14）

**設計正本: `docs/design-phase4-site.html`**（実データモック込みのHTML設計書。Fable 設計）

- 目的は **X bot 化（スピード優先）**。サイトは X ポストのリンク先（ナルエビ方式の導線）
- 構成: 既存 Actions を1本に拡張 — pipeline → `data/YYYY-MM-DD/` コミット → 静的ビルド（新規 `src/site/build.ts`, zero-dep）→ GitHub Pages → X 日次ダイジェスト投稿（新規 `src/site/postToX.ts`）
- パイプライン側の改修は articles JSON 書き出し1点のみ（renderMarkdown と同じ構造化データを JSON でも出す）
- X API は2026年2月から従量課金（URL付きポスト $0.20/本・**要一次確認**）→ リンクは日次ダイジェスト1本に集約（月額目安 $6）
- 段階導入: 4a MVP（自動でサイト更新+投稿1本）→ 4b 個別投稿+OGP画像+RSS → 4c 表示量切替/絞込/検索 → 4d WebMCP/計測
- 未決事項: X 課金の一次確認 / LICENSE・引用ポリシー整備 / 確定キャラクターの公開用素材化
- キャラクター設計: ✅ **承認済み（2026-07-15）**。設計正本 `docs/design-phase4-character.md`。
  確定: 冰糖（ビンタン）／サイト名「冰糖日报（ビンタンちゃんデイリー）」／です・ます調＋「ね」「よ」語尾／
  運営者呼称「Falさん」／Xハンドル @bingtang_chan 仮置き。反映手順（V1・C1〜C6）は同文書に記載。
  旧A案（ミーシュ/パンダ）は棄却。外見は `docs/assets/bingtang-character-final-reference.png` で最終確定（2026-07-16）。
  公開用の透過立ち絵・丸型アバター・ヘッダー用素材への展開は Phase 4a UI差分設計後に行う。
- キャラクター反映 C1〜C3: ✅ **実装完了（2026-07-15）**。`editorial-character.md` へ確定文面を一字どおり適用し、
  Markdown見出しを「ビンタンの注目ポイント」「ビンタンからのひとこと」へ変更、プロンプトの旧少女口調を除去。
  `npm run check` 通過、ダミー出力で新見出し2件・旧見出し0件、旧口調文字列0件。診断実測は候補99件、
  官庁比率34.3%、媒体fresh 40件、複数ソースtopic 5件。実生成のです・ます調確認は Actions(deepseek) 待ち。
- 4a 前提「タイトル未設定」生成バグ: ✅ **修正完了（2026-07-16）**。空白・固定プレースホルダーを欠損扱いにし、
  記事/topic の元タイトルへフォールバック、Markdown 出力直前にも同じ防御を追加。`npm run check` と
  `npm run test:title`（タイトル解決6ケース＋ダミーMarkdown 1件）通過、「タイトル未設定」出力0件。
  ローカル `npm run start` は完走したが全7収集元が通信失敗で当日候補0件のため、選定実測は直近成功値
  （候補99件・官庁比率34.3%・媒体fresh 40件・複数ソースtopic 5件）を維持基準とする。
- サイトのビジュアル方向: ✅ **B案を採用（2026-07-16）**。写真素材は基本使わず、確定したビンタンの
  キャラクターを中心にした明るいカードUIで進める。Phase 4a 実装時に設計モックへ反映する。
- Fable引き渡し準備: ✅ **完了（2026-07-16）**。確定キャラ、B案参照、採用／不採用要素、既存設計との
  不一致、差分設計の必須成果物を `docs/fable-phase4a-bingtang-handoff.md` に集約。次はFableによる
  `docs/design-phase4a-bingtang-ui.md` 作成と設計文書の整合更新。
- Phase 4a UI差分設計: ✅ **完了（2026-07-16・Fable）**。**UI実装正本 = `docs/design-phase4a-bingtang-ui.md`**。
  確定: 最終キャラ画像の5色パレット（氷青 #A7CDDF／紅 #C12B23／アンバー #CD7019／濃紺 #1F3043／アイボリー #F0E6DA）、
  写真なしカード（種別色トップバー＋チップ列＋アバター吹き出し）、フィード=PC2列コンパクトカード→個別ページで全文、
  キャラ大型表示はヘッダのみ。B案のカテゴリタブと相対時刻表示は不採用（絞込は 4c 送り・データにない表示はしない）。
  design-phase4-character.md の V1 完了反映と design-phase4-site.html への確定注記も適用済み。
  **次タスク: Codex による Phase 4a 実装（U1〜U5。手順・受け入れ基準・検証は UI正本 §11〜§12、⚠️ なし）**

### 継続課題（フェーズ外・随時）

- 澎湃新闻: channel ページが JS レンダリングで実質死んでいる（現在は誤混入防止で空）。
  RSSHub `/thepaper/channel/25951` などの代替 URL を実測して差し替え
- 豆瓣・猫眼: sources.json に `enabled: false` の候補あり。RSSHub 実測後に有効化
- 微博热搜: `fetchHotSearch.ts` は実装済みだが公開 RSSHub が不安定。ベースURL差し替えで解決を図る

## モデル振り分け指針（コスト管理）

日常の実装は Codex や下位モデル（Sonnet/Haiku 等）、**要所だけ Fable** に依頼する。

### Codex / 下位モデルに任せてよい作業（日常）

- 上記タスクの実装作業そのもの（設計が本ドキュメントに書いてある範囲）
- ソース追加・URL パターン調整・キーワード辞書の増減
- バグ修正、型エラー解消、ログ/診断の追加
- audit / trace の実行と数値確認

### Fable に依頼すべき要所（1タスク=1セッションで完結させる）

1. **LLM プロンプトの初版設計**（2-1 の topic seed 抽出、2-3 の summarizeTopic）
   — 出力品質を決める一番のレバー。初版を Fable で作り、微調整は下位モデルで
2. **フェーズ完了時の設計レビュー**（Phase 2 完了時に実出力を添えて依頼）
3. **出力品質が狙いとずれた時の原因分析**
   — 「また公式に偏った」「topic が壊れた」等。trace/audit の JSON を添えて依頼
4. **アーキテクチャの分岐点**（検索 API 選定、topic-first 切替の設計判断）

### Fable への依頼テンプレート

```
docs/roadmap.md のタスク 2-x をやりたい。
前提: AGENTS.md と docs/roadmap.md を読んでから始めて。
現状の実出力: output/selection_trace_YYYY-MM-DD.json（または Actions artifact を添付）
依頼内容: <設計/レビュー/原因分析のどれか + 具体的に>
```

## 引継ぎ運用ルール（どのモデルでも共通）

1. **セッション開始時**: `AGENTS.md`（Codex は自動読込）→ 本ドキュメントの順に読む
2. **1タスク = 1受け入れ基準**。受け入れ基準を満たすまで完了にしない
3. **検証は必ず実測**:
   - `npm run check`（型）
   - `npm run audit:sources`（ソース健全性。媒体 fresh>0 を維持）
   - `npm run start`（ローカルは Gemini 不達で AI 要約は失敗するが、selection_trace までは検証可能）
   - AI 要約込みの検証は GitHub Actions の generate-news（provider: deepseek）
4. **変更前後で trace/audit を比較**: 官庁比率・媒体 fresh 件数・multi-source topic 数が後退していないこと
5. **タスク完了時**: 本ドキュメントのフェーズ状況を更新し（✅ + 実測値1行）、コミットする
6. **編集方針に関わる変更**（プロンプト、スコア、選定）は `docs/editorial-character.md` と矛盾しないか確認
