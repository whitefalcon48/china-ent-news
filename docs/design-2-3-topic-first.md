# 設計: 2-3 topic-first 生成（Fable 設計 2026-07-06）

roadmap タスク 2-3 の実装設計。**この文書に沿って Codex が実装する**。
設計判断の変更が必要になったら実装を止めて Fable に相談すること。

## 0. 設計の土台にした実データ（output/topic_candidates_2026-07-06.json）

- topic 100件、複数 evidence の topic が7件（野狗骨头×2、三国第一部：争洛阳×2、上海国际电影节×3 など）
  → topic-first 生成の素材は既に存在する
- **発見した問題**: k.sina のファン投稿「20岁的baby真的好灵动…」が
  `articleType: sns_trend` 判定 → snsHeat high 加点でスコア100・publish_priority high の最上位。
  単独SNS evidence のジャンク topic が最上位に来る構造がある。
  → 本設計に「SNS単独 topic のスコア上限」ガードを含める（§3）
- seed 抽出はローカルでは Gemini 不達で regex fallback。Actions(deepseek) では LLM seed になる前提

## 1. 全体方針（実装コストを抑える2つの決定）

1. **出力 JSON の契約（`SummarizedArticle`）は変えない。**
   summarizeTopic は「topic の evidence 束を入力に、既存と同じ JSON を1つ返す」。
   これにより `normalizeSummary` / `renderMarkdown` はほぼ無変更で使える。
   出力の見た目の再定義は 2-4 で行う（タスク分離を維持）。
2. **candidate_pool（記事単位の trace）は残す。**
   roadmap 運用ルール4の後退チェック（官庁比率・媒体 fresh）は記事単位の指標なので、
   trace に topic 選定セクションを「追加」する形にする（置換しない）。

旧経路（`mergeTopicDuplicates` → `selectArticlesForAi` → `summarizeArticle`）は
2-3 では削除せず残す。環境変数 `TOPIC_FIRST=false` で旧経路に戻せる脱出ハッチを付ける
（デフォルトは topic-first ON）。撤去は 2-4 完了後。

## 2. データフロー（新経路）

```
expandTopicSources 後の topicCandidates（既存）
  → selectTopicsForAi (§3: topic単位のゲート + カテゴリ/ソース上限)
  → 各選定topicの代表evidenceを enrichArticleContent (§4)
  → summarizeTopic(topic, enrichedEvidence) (§5)  ← 1 topic = 1 LLM呼び出し
  → ProcessedArticle { raw: 代表記事, summary, topic } → renderMarkdownFile（既存のまま）
```

`MAX_ARTICLES`（既定8）の意味は「最大 topic 数」に変わる。env 名は互換のため変えない。

## 3. selectTopicsForAi の設計

### 3-1. topic の適格ゲート（記事単位ゲートの移植）

topic が AI 入力候補になる条件（すべて必要）:

1. `topic.freshness_label` ∈ {today, yesterday, recent}（既存の topic freshness は evidence の最良値）
2. **fresh かつ publishable な evidence 記事が1件以上ある**。
   記事の判定は既存関数を再利用: `isGenerationEligibleBeforeFreshness(article) && isFreshEnoughForNormalFeed(article)`
   （expansion 由来 evidence（`freshness_label: unknown`）はこの判定対象外＝topicを適格化しない。反応素材としてのみ使う）
3. 代表記事（下記）が決まること

**代表記事（representative）**: 条件2を満たす evidence のうち `getAiInputPriorityScore` 最大のもの。
カテゴリ判定・本文取得・確度の基準になる。

### 3-2. topic の選定スコア

```
score = max(条件2を満たすevidenceの getAiInputPriorityScore)
if (topic.signals.has_multiple_sources) score += 12
if (has_official_source && has_media_context) score += 10
if (has_hot_search_signal && (has_media_context || has_official_source)) score += 8   // SNS×他タイプのクロス温度
// ★ジャンクガード: SNS単独（evidence が1件で media/official/data の裏付けなし）は上限55
if (snsOnlySingleEvidence) score = min(score, 55)
```

同じ上限ロジックを `topicCandidates.ts` の `getTopicScore` にも入れる
（topic_candidates.json の publish_priority が high と誤表示される問題の修正。§0の発見への対処）。

### 3-3. 上限ロジック（カテゴリ/ソース上限の移植）

`selectArticlesForAi` のカテゴリ・ローテーション構造をそのまま topic 版に写す:

- カテゴリ = 代表記事の `feedCategory`。`CATEGORY_LIMITS` は既存値をそのまま使う
- ソース上限 = 代表記事の `sourceName` で数え、**1ソースあたり最大2 topic**
  （記事単位の3から減らす。topic は記事より太くなるため。定数 `MAX_TOPICS_PER_PRIMARY_SOURCE = 2`）
- **SNS単独 topic は最大2件**（`MAX_SNS_ONLY_TOPICS = 2`）。HOT SEARCH 観測メモの席は残すが独占させない
- low priority topic（条件2を満たす evidence が全て `isLowPriority`）は既存 `MAX_LOW_PRIORITY_ARTICLES = 3` を流用
- 落選理由は topic 単位で trace に記録: `topic_count_limit` / `topic_source_limit` /
  `topic_category_limit` / `topic_sns_only_limit` / `topic_low_priority_limit` / `topic_not_fresh` / `topic_no_publishable_evidence`

## 4. evidence の本文準備

- topic から evidence を最大4件選ぶ。順序: 代表記事 → sourceType の多様性優先（official → media_report → data → sns）→ スコア順
- `enrichArticleContent` は**代表記事＋2件目まで**（fetch コスト制御）。3件目以降は title + key_points のみ
- 本文量: 代表記事は既存の 5000 字上限、2件目は 1500 字に切り詰め
- `isTooThinForPublishing` は**代表記事にだけ**適用（代表が薄い topic は落とす。理由 `topic_raw_content_too_short`）
- expansion 由来 evidence（RSSHub 検索結果）は本文 fetch しない。title + key_points を「SNS/検索反応」としてプロンプトに渡すだけ

## 5. summarizeTopic プロンプト初版

実装先: `src/summarizeWithGemini.ts` に `summarizeTopic(topic, evidence, provider)` を追加。
`generateJson` / `parseJsonFromModelText` / `normalizeSummary` は既存を再利用。
`mergeInternalMetadata` は topic 版 `mergeTopicInternalMetadata` を作る（§6）。

以下が初版プロンプト全文。`${...}` は実装時のテンプレート変数。

```text
あなたは中国エンタメの topic-first フィードを作る編集補助AIです。
複数の情報源（evidence）を束ねた「1つのトピック」を、1本の日本語ニュースメモに整理します。

Editorial character policy document (docs/editorial-character.md):
${editorialCharacter}

Use the document above as the highest-priority editorial policy.

目的:
- 入力は1つのトピックと、その根拠となる複数のevidence（公式発表・媒体記事・データ・SNS反応）。
- 表に出す文章は、ナルエビちゃんニュース型の軽いニュースメモにする。
- 1本あたりの日本語本文量は通常400〜700字程度。公式発表系は300〜500字、ゴシップ・騒動系は500〜800字まで。
- 真偽判定や独自検証はしない。evidenceにある情報の抽出・分類・再構成だけを行う。

evidenceの扱い方（重要）:
- [E1] が代表記事。出来事の骨格は代表記事と official evidence から組み立てる。
- source_type ごとの役割:
  - official: 事実の骨格（日付・数字・固有名詞）。ただし中立とは限らない。官製PR・文化輸出の文脈は一歩引いて見る。
  - media_report: 文脈・詳細・業界的な見られ方。
  - data: 票房・評分・热度などの数字。数字はdata/officialのevidenceにあるものだけ使う。
  - sns: 現地温度の観測メモ。断定材料にしない。「SNS上では〜という反応が出ている」の粒度で書く。
- evidence間で数字・日付・事実が食い違う場合は、どちらかに寄せず「Aでは○○、Bでは△△」と並記する。捏造して整合させない。
- 出典の弱いevidence（sns/rumor）の情報を「何が起きた？」の事実パートに昇格させない。反応・見られ方かひとことに留める。

禁止事項（最優先で守る）:
- evidenceにない情報を補わない。業界一般論や背景説明で空欄を埋めない。
- 【単一ソースの場合】evidenceが実質1ソースしかないトピックでは、複数視点があるかのように書かない。
  reaction_view は空文字にし、has_multiple_sources は false にする。
- SNS evidenceが無いのにSNS反応を書かない。has_sns_signal は false、reaction_view は空文字。
- 未確認情報を断定しない。ゴシップは「報じられた」「SNS上で話題」など出典に応じた表現にする。
- 中国人名・作品名を勝手に日本語読みへ変換しない。原文表記を基本にする。
- 使わなかったevidenceを source_list に入れない。実際に本文の根拠にしたevidenceだけを列挙する。

構成ルール:
- lead: 2〜3行。トピック全体として何が起きたか。
- what_happened: 150〜250字。official/media evidenceの事実だけで、出来事・数字・日付・関係者を整理。
- reaction_view: SNS evidenceまたは複数媒体の見られ方がある場合のみ150〜250字。根拠がなければ空文字。
- why_it_matters: このトピックがなぜ今出てきたのか、現地でどういう位置づけかをevidenceの範囲で。
- japan_context_note: 日本語圏では見えにくい文脈がある場合だけ（中国で高評価だが日本未紹介、ファン文化、国策文脈、日本公開情報など）。なければ空文字。
- editor_comment: 編集者キャラの「ひとこと」。内部メモではなく読者向けの短い見方。
- 確度(confidence): official evidenceを含み複数ソースが整合 → A〜B。媒体単独 → B〜C。SNS単独 → C〜D。
- badge: officialが骨格ならOFFICIAL、SNS主導ならHOT SEARCH、データ主導ならDATA、官製PR色が強ければPR WATCH、それ以外はNEWS。
- topic_key は入力の topic_key をそのまま返す。
- 必ずJSONだけを返す。

返すJSON:
${既存 summarizeArticle と同一の JSON スキーマをそのまま貼る}

入力トピック:
- topic_key: ${topic.topic_key}
- 出来事: ${topic.event_sentence}
- topic_type: ${topic.topic_type}
- freshness: ${topic.freshness_label} (${published_date_range})
- source_count: ${topic.source_count}
- source_mix: ${JSON.stringify(topic.source_mix)}
- 事前japan_gap: ${topic.japan_gap} / 事前context_value: ${topic.context_value}
- caution_note: ${topic.caution_note}

evidence一覧:
${evidenceを以下の形式で列挙}
[E1]（代表）source: ${source_name} / type: ${source_type} / 確度: ${reliability} / 日付: ${published_date}
タイトル: ${title}
URL: ${url}
本文: ${rawContent（代表は5000字、2件目は1500字）}

[E2] source: ... / type: ... / 確度: ... / 日付: ...
タイトル: ...
本文: ...（または key_points のみ）

[E3] （SNS/検索反応・本文なし）source: ... / type: sns
タイトル: ...
key_points: ...
```

### プロンプト設計の意図（Codex がいじる時の注意）

- 「単一ソースで複数視点を演出しない」「SNSを事実に昇格させない」「矛盾は並記」の3つが
  このプロンプトの背骨。文言を短縮しても**この3ルールは削らない**
- source_list の「使ったevidenceだけ列挙」は、renderMarkdown のソース表記が
  実際の根拠と一致するための契約。緩めない
- 確度マトリクス（official+複数=A〜B / 媒体単独=B〜C / SNS単独=C〜D）は
  editorial-character.md の確度方針の topic 版。変更時は同文書と整合させる

## 6. mergeTopicInternalMetadata（LLM出力への後処理）

既存 `mergeInternalMetadata` の topic 版。強制上書きする項目:

- `topic_key` = topic.topic_key
- `source_list` / `related_sources` = 実際にプロンプトへ渡した evidence のソース（name+url、ソース名で dedupe）。
  ただし LLM が返した source_list がこの部分集合なら LLM 版を尊重（「使ったものだけ」の契約）
- `source_count` = source_list の件数、`has_multiple_sources` = source_count > 1
- `has_official_source` = evidence に official/pr_like がある
- `has_sns_signal` = evidence に sns がある（無いのに true を返したら false に矯正、reaction_view も空に矯正）
- `published_date` / `event_date` / `freshness_label` = 代表記事の値を fallback
- `badge` / `source_type`: LLM 値を基本にし、既存 merge と同じ「NEWS/media_report のときだけ事前値で上書き」

## 7. selection trace / ログの追加

- `selection_trace` に `topic_selection` セクション追加:
  `{ enabled, selected: [{topic_key, category, primary_source, score, evidence_urls, selection_reason}], dropped: [{topic_key, reason}] }`
- 既存 `candidate_pool` / `deepseek_input`（記事単位）は当面残す。`deepseek_input` には
  代表記事を入れて互換維持（`topic_layer_note` を「topic-first generation enabled」に更新）
- コンソール: 「topic選定: N件（SNS単独x件・複数ソースy件）」「AI処理中: [topic] key (evidence n件)」

## 8. 実装手順（Codex 向け・この順で）

1. `src/types.ts`: `ProcessedArticle` に `topic?: TopicCandidate` を追加
2. `src/summarizeWithGemini.ts`: `buildTopicPrompt` + `summarizeTopic` + `mergeTopicInternalMetadata`（§5, §6）
3. `src/index.ts`: `selectTopicsForAi`（§3）+ evidence enrich（§4）+ `TOPIC_FIRST` フラグ分岐。
   旧経路の関数は削除しない
4. `src/topicCandidates.ts`: `getTopicScore` に SNS単独上限55 を追加（§3-2）
5. trace / ログ（§7）
6. 検証（§9）→ roadmap 更新 → コミット

## 9. 検証（受け入れ基準の確認方法）

1. `npm run check`
2. `npm run start`（ローカル）: LLM は失敗するが、
   - `topic_selection.selected` に複数 evidence の topic（野狗骨头型）が入ること
   - SNS単独ジャンク topic（「婴儿肥」型）が上位を独占せず `topic_sns_only_limit` 等で制限されること
   - 官庁比率・媒体 fresh の後退がないこと（candidate_pool 指標）
3. Actions(deepseek) で実行:
   - **受け入れ基準1**: 複数 evidence topic の出力記事で「ソース：」に複数リンクが並ぶ
   - **受け入れ基準2**: 単一 evidence topic の出力で reaction_view が空 or SNS evidence 由来のみ、
     has_multiple_sources=false であること（捏造なしの確認）
4. `TOPIC_FIRST=false` で旧経路が動くこと（脱出ハッチ確認）

## 10. このタスクでやらないこと

- Markdown の見た目の再定義（2-4）
- 旧経路（mergeTopicDuplicates / selectArticlesForAi / summarizeArticle 経路）の撤去（2-4 後）
- RSSHub ベースURL問題の解決（2-5 / 継続課題）
- `getNewsworthinessScore`（記事単位）の再調整 — sns_trend 加点が強すぎる件は
  上限ガードで受けるに留め、根本調整は Phase 2 完了レビューで判断
