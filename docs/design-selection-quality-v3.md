# 設計: 選定品質・コメント品質 v3 — 編集価値スコアと掲載履歴（Fable 設計セッション 2026-07-19）

2026-07-19 の実出力（10本中7本が前日と同一topic・「要するに」開始9本・公式のみ3本・レビューで6/10却下）の原因分析に基づく立て直し設計。公開判断専用の「編集価値スコア（EVS）」10点制・7点以上のみ公開、過去掲載履歴とレビュー結果による重複制御、ソース拡張の再配置、コメント生成v3を導入する。この文書に沿って Codex が実装する。設計判断はすべて確定済み。R1〜R7・B1〜B12・U1〜U7 は実装済みが前提。**実装は §0 のとおり P0（本日: 実装 → Actions 検証 → サイト生成まで）と P1（後日）に分割する。P0 は単独で検証・公開できる完結した仕様で、タスク列 V1〜V12 がそのまま P0 である。**

## 0. 実装フェーズ分割（P0 = 本日 / P1 = 後日）

**P0 要件と実現箇所**:

| P0 要件 | 実現箇所 |
|---|---|
| 10点満点・7点以上のみ採用 | §2・§3（EVS。D/E は LLM バッチ1回＋fallback） |
| 7点未満で本数を埋めない | §5（可変本数・下限なし） |
| 過去掲載topicの単純再掲載防止 | §4 の P0 規則（過去5日の履歴と照合し、強い更新が無ければ除外） |
| official-only 上限 1日1本 | §5 |
| single-source 単純要約の抑制 | §2（B=0 は cap 6・例外2種のみ B=1 昇格） |
| final_fill の制約迂回禁止 | §5 |
| 「要するに」固定化・本文言い換え防止 | §7（プロンプトv3・書き出し重複検査・4字シングル言い換え検査） |
| score 内訳・除外理由の trace 出力 | §8 |

**P0 の簡略化**（P1 へ先送りする精密化。P0 は迷ったら常に「除外側＝安全側」に倒す）:

- 実質的更新の判定は**強い更新3種（official_decision / principal_response / result）のみ**。new_numbers（弱い更新）の数字差分判定は P1。P0 では数字だけの続報は再掲されない（安全側）
- cooldown は履歴の status・reason_tag によらず**一律**「履歴一致 → 強い更新が無ければ除外（dup_no_update）」。reason_tag 別の細分化（cooldown_rejected / in_review の区別）は P1
- 履歴の構築は `review.json`＋`articles JSON` のみ（fact_ledger の numbers 読込は P1）
- ソース拡張は**現在の実行位置のまま**、対象決定のみ修正する（fresh 候補に限定して上位8件×2クエリ＋SKIP_RSSHUB）。ゲート後ショートリストへの完全再配置は P1
- コメントの言い換え検出は4字シングル法（§7-3）まで。意味類似度による高度化は P1

**P1 の一覧**（詳細は §13）: P1-1 弱い更新（new_numbers）差分判定 / P1-2 reason_tag 別 cooldown / P1-3 ソース拡張のゲート後再配置 / P1-4 コメント類似度判定の高度化 / P1-5 スコア配点の長期見直し（review-feedback 集計との突合。自動学習はしない）

## 1. 品質後退の根本原因（2026-07-19 実測）

### 1-A. 情報完全性ゲートの thin_unknown 誤爆（最大の要因）

- information_gate は 41件評価・17件除外、うち16件が `thin_unknown` 単独理由。除外された中に当日の正常候補が多数含まれる: 周星驰路演哽咽（人物entity有・key_points 15字）、刘宇宁厨艺翻车（同19字）、电影《群星闪耀时》特别放映（entities 3/1・29字）、郎朗《钢琴书2》蝉联 等。
- 原因: thin_unknown の条件「topic_type unknown ∧ 単一ソース ∧ key_points 40字未満」が、**候補段階の key_points がタイトルのみ（excerpt未取得）になりがち**という実データ特性を踏まえていなかった。主語entityを持つ正常候補まで巻き込んだ（設計時の想定より発火域が広い。設計ミス）。
- 結果: 当日候補（today/yesterday 7件）がほぼ全滅し、freshness "recent"（3日以内）の前日topicが再選定された。

### 1-B. 掲載履歴・レビュー結果の不参照

- 過去日の掲載topic・review-feedback.jsonl を選定が参照していないため、同一topicが毎日再生成・再掲載される（07-19 は 10本中7本が 07-18 と同一。うち再掲の 微短剧大赛・红色微短剧展・电视剧发行许可・袁娅维 は 07-19 レビューで却下された）。
- 07-18 に全件承認 → 07-19 に同一topicを再掲 → 却下、という無駄なループが発生している。

### 1-C. ソース拡張の全滅

- RSSHub（rsshub.app）は 3 topic × 3ルート全て HTTP 403（Actions からブロック）。Serper は `SERPER_API_KEY is not set`（workflow の生成ステップに Secret 未配線。commit 988fc27 で修正済み・実測未）。
- 拡張対象が「候補配列の先頭3件（選定前のスコア順）」のため、仮に成功しても選定される topic と一致する保証がない。
- 結果: 9/10 が単一ソース、公式のみが3本。

### 1-D. スコアと選定の構造問題

- newsworthiness_score は「シグナルの強さ」の点数であり編集価値ではない。単一ソースでも 90点台（留几手批冯小刚=98 → レビュー却下「炎上系ライバーで中身がない」、红色微短剧展=94 → 却下「面白みに欠ける」）。
- final_fill は `getTopicNonCategoryLimitReason`（ソース/SNS単独/low上限のみ）を使い**カテゴリ上限を確認しない**ため、公式発表カテゴリ2枠が埋まった後に3本目の官庁topic（备案）が final_fill で通過した。official-only の1日上限も存在しない。

### 1-E. コメントの「要するに」固定化と本文言い換え

- コメント工程プロンプトが「最初の1文は『要するに何が起きているのか』を言い切る」「『要するに、〜ということです！』の形を使ってよい」と指定しており、temperature 0.1 の DeepSeek は 10本中9本で「要するに、」開始に収束。
- 「噛み砕き説明をここでやる」指示が、説明不要の記事にも適用され、本文の言い換えが注目ポイントを占めた（レビュー却下理由「ニュースバリューが注目ポイントから分からない」= 优酷《东大高武学院》）。
- 書き出しの多様性・本文との意味的重複を検査する仕組みがない。

## 2. 編集価値スコア（EVS）— 10点制の採点表

newsworthiness_score（供給シグナル）とは独立の、**公開判断専用スコア**。候補ごとに5軸 0〜2 点、合計10点満点。**7点以上のみ公開対象**。全軸の点数と理由を trace に記録する。

| 軸 | 内容 | 判定 | 配点基準 |
|---|---|---|---|
| A 新規性・実質的更新 | 過去掲載との関係 | deterministic | 履歴に一致なし: freshness today/yesterday/recent=2（過去5日の掲載履歴にない「サイトとして新規」の話題）。履歴一致あり: 強い更新（§4の official_decision / principal_response / result）=2、更新なし=**採点前に除外**（dup_no_update）。※弱い更新（new_numbers のみ）=1 は P1 で追加。P0 では数字のみの続報も除外される |
| B 裏付け・複数ソース | 独立ソースとsource typeの多様性 | deterministic（expansion 後に算定） | 独立ソース2以上かつ source_type 2種以上=2、独立ソース2以上（同一type）=1、単一ソースで例外該当=1、その他単一ソース=0 |
| C 現地温度・反応の可視性 | SNS・データ・反応の存在 | deterministic | SNS/热搜 evidence あり、または data evidence に評分・热度（豆瓣/猫眼/热搜）=2、媒体が反応・議論を報道（evidence タイトル/key_points に 引发/热议/回应/争议/刷屏）=1、なし=0 |
| D 日本語圏へ渡す意味 | ズレ埋め価値 | **LLM**（バッチ1回） | 2=日本語圏でほぼ見えず知る価値が明確、1=部分的に既知だが文脈補足に価値、0=渡す意味が薄い |
| E ビンタン独自の解説・観察 | 本文言い換え以外のコメント余地 | **LLM**（同バッチ） | 2=制度・文化・数字の読み方など独自の切り口を明確に乗せられる、1=多少の補足のみ、0=言い換え以外に余地なし |

**独立ソース判定（転載水増し対策）**: source_name が異なり、かつタイトルの正規化類似度が既存 dedupe の閾値未満（同一文の転載は1ソースと数える）。expansion 由来 evidence も同じ判定を通す。

**cap ルール（deterministic）**:

- **単一ソース cap**: B=0（単一ソースかつ例外なし）の候補は `EVS = min(EVS, 6)` → 7点に届かず自動的に不採用。trace に `single_source_cap` を記録
- **単一ソース例外（B=1 に昇格・capなし）**: ①独自取材系 = article_type が interview / タイトルに `专访|独家|调查|评论` を含み reliability B 以上の媒体 ②公式一次資料系 = official ソースがリスト・データを公表するもの（タイトルに `备案|许可|名单|公示|数据` を含む）。trace に `single_source_exception: "original_reporting" | "official_primary_release"` を記録
- **official-only 上限**: source_mix が official+pr_like のみの候補は、EVS 7 以上でも**1日1本まで**。2本目以降は `official_only_limit` で除外
- 公式発表・备案・許認可の単純紹介が穴埋めに使われない根拠: official-only は上記2つの cap（単一なら6点cap、例外昇格でも D/E で7点に届く必要 + 1日1本）を全て通らないと出ない

**2026-07-19 データでの検算（設計書に記載する）**:

- 留几手批冯小刚（data単独1ソース・例外なし）: B=0 → cap 6 → 不採用（実レビューの却下と一致）
- 红色微短剧展（媒体1ソース・07-18掲載・更新なし）: dup_no_update で除外（却下と一致）
- 备案（国家电影局の6月备案公示・新規）: 例外② official_primary_release → B=1。A=2 で D+E が 4 なら 7 到達可（実レビュー「選定はいい」と一致）。official-only 枠 1 を消費
- 功夫女足偷票房疑云（07-18掲載・同一 evidence URL のみ）: 新 evidence がないため dup_no_update で除外。同一URLの記事更新検出はP1以降の課題とし、P0は安全側へ倒す
- 微短剧大赛・电视剧发行许可・袁娅维・蔡赴朝（07-18掲載・更新なし）: dup_no_update で除外

## 3. deterministic 判定と LLM 判定の分担

- **deterministic**: A（履歴照合・更新判定）、B（独立ソース数・type数・例外）、C（evidence の type とキーワード）、全 cap、7点ゲート、official-only 上限。理由文字列も機械組み立て（例: `"B=2: 独立3ソース(media,data,sns)"`）
- **LLM（1実行につきバッチ1回）**: D・E のみ。ゲート・履歴を通過した候補（最大20件）を1プロンプトで採点。出力は各候補 `{ japan_value, japan_reason(40字以内), bingtang_angle, angle_reason(40字以内), angle_hint(30字以内) }`。**angle_hint はコメント工程（§7）に切り口ヒントとして渡す**
- **LLM 失敗時の graceful fallback**: D = japan_gap ヒューリスティック（high=2/medium=1/low・unknown=0）、E = 1 固定。trace に `evs_llm: "fallback"` を記録し、7点ゲートはそのまま適用する（fallback でも埋め合わせ採用はしない）
- budget: EVS バッチ +1 呼び出し（07-19 実測 used 35 → 36 前後。上限 60 内）

**EVS 採点プロンプト（確定形・一字も変えない）**:

```text
あなたは中国エンタメニュースの編集価値を採点する編集AIです。以下の候補トピックそれぞれについて、2つの軸を0〜2点で採点します。

このサイトの目的: 中国現地で実際に評価され、語られ、消費されているエンタメと、日本語圏で見えている中国エンタメ像のズレを埋める。読者は中国エンタメに関心のある日本語話者。

軸D: 日本語圏へ渡す意味・補足価値（0〜2）
- 2: 日本語圏ではほぼ報じられない・見えにくい話で、知る価値がはっきりある（現地で大きい出来事、日本と関係が生じる話、日本の中国エンタメファンの関心事）
- 1: 日本語圏でも部分的に知られているが、現地文脈の補足に価値がある
- 0: 日本語圏の読者に渡す意味が薄い（ローカルすぎる行政話題、単なる番組告知、内輪ネタ）

軸E: ビンタン独自の解説・観察を乗せられるか（0〜2）
- 2: 制度・業界慣行・ファン文化・数字の読み方など、噛み砕き解説や独自の見方をはっきり乗せられる
- 1: 多少の文脈補足はできるが、本文以上のことは言いにくい
- 0: 事実を言い換える以外にコメントの余地がない

規則:
- 評価は与えられた情報（タイトル・出来事・エンティティ・ソース構成・key_points）だけで行う。知らない作品・人物を知っているかのように評価しない。
- japan_reason / angle_reason は40字以内。
- angle_hint には、ビンタンがコメントで扱える具体的な切り口を30字以内で入れる（bingtang_angle が1以上のときだけ。0のときは空文字）。
- 必ずJSONだけを返す。説明文やMarkdownは返さない。

返すJSON:
{
  "scores": [
    { "topic_key": "", "japan_value": 0, "japan_reason": "", "bingtang_angle": 0, "angle_reason": "", "angle_hint": "" }
  ]
}

候補一覧:
```

（末尾に候補ごとの `topic_key / タイトル / event_sentence / topic_type / entities / source構成（official・media・sns・data の件数）/ key_points 要約` を列挙する）

## 4. 掲載履歴・実質的更新・cooldown のデータ設計

**新しい永続ファイルは作らない**。実行時に `data/YYYY-MM-DD/`（過去5日分）の `review.json`・`articles_*.json` から履歴をメモリ上に組み立てる（新規 `src/publicationHistory.ts`）。日付ディレクトリやファイルが無い日はスキップ（graceful・後方互換）。`fact_ledger_*.json` の numbers 読込は P1（弱い更新判定用）で追加する。

履歴エントリ（メモリ上・P0）: `{ date, topic_key, title, status(approved/rejected/revision_requested/pending), reason_tag, entities(works/people), topic_type, evidence_urls }`（P1 で numbers・opening を追加）

**同一topic判定**: `src/topicKey.ts` に純関数 `areTopicsLikelySame(a, b)` と一致度関数を追加（topicKey ロジックの一元管理原則に従いここへ置く）。判定 = ①正規化 topic_key の完全一致、②topic_type が一致し、短い側の正規化キーが6文字以上で長い側に包含される、③works∪people の entity 交差が1以上かつ topic_type が一致、のいずれか。複数履歴に一致する場合は ①→②→③、同順位なら長い topic_key を優先し、最も具体的な履歴と比較する。表記違い・キーの包含は「続報」の根拠にせず、実質的更新には必ず新 evidence URL を要求する。

**実質的更新の定義（P0・deterministic）**: 履歴一致 topic に対し、①履歴に無い新しい evidence URL が存在し、かつ②その新 evidence のタイトル/key_points が次のいずれかに該当する:

- `official_decision`（強）: `官宣|定档|立项|批准|获奖|得奖|夺冠|判决|处罚|立案|声明|公告`
- `principal_response`（強）: `回应|本人|受访|发文|发声|承认|否认`
- `result`（強）: `开播|首播|上映|收官|大结局|突破|破.{0,3}亿|夺冠|登顶`

新 evidence が無い、または上記に該当しない場合は「更新なし」。`new_numbers`（弱: 新 evidence の数字トークンが履歴の numbers に無い。claimCheck の正規化を再利用）は **P1 で追加**する。

**cooldown（P0 = 一律規則）**: 履歴一致 topic は status・reason_tag によらず、強い更新が無ければ `dup_no_update` で除外する。強い更新があれば再選定可（A=2）。以下の status 別テーブルは **P1** で導入する:

| 履歴 status | 再選定条件（P1・履歴window 5日） |
|---|---|
| approved | 実質的更新（強・弱どちらでも）があれば再選定可（A=強2/弱1）。無ければ dup_no_update で除外 |
| rejected（reason_tag 選定/その他） | **強い更新のみ**再選定可（A=1）。弱い更新では除外（cooldown_rejected） |
| rejected（口調/構成/用語 = 生成品質の却下） | approved と同じ扱い（topic自体は否定されていない） |
| revision_requested / pending | レビュー継続中のため新規生成から除外（in_review） |

## 5. 選定フロー v3・final_fill と official 上限の修正

```
topicCandidates（seed・既存gate入力）
 ※ソース拡張は P0 では現行位置（候補生成直後）のまま。対象決定のみ §6 P0 版に修正
 → 情報完全性ゲート（V1で thin_unknown 修正）
 → 履歴照合・cooldown ゲート（§4 P0規則。dup_no_update を除外）
 → EVS 算定（deterministic A/B/C + LLMバッチ D/E）＋ cap 適用
 → 7点ゲート（未満は evs_below_threshold:<内訳> で除外）
 → 選定: EVS 降順 → 既存の上限（カテゴリ各2・ソース2・SNS単独2・low 3）＋ official-only 1
 → final_fill: 合格プールから、**全上限（カテゴリ上限含む）を確認して**補充
 → 出力本数 = 合格数（上限 maxArticles=10・下限なし。10未満を許容）
```

- **final_fill 修正**: `getTopicNonCategoryLimitReason` にカテゴリ上限チェックを追加する（または final_fill 側も `getTopicLimitReason` を使う）。final_fill は「7点合格プールの中で枠に空きがある限り補充する」だけの存在になり、**閾値・カテゴリ上限・official-only 上限を迂回できない**
- **official-only 上限**: 選定ループに officialOnlyCount を追加し、source_mix が official+pr_like のみの topic は1件まで。2件目以降は dropped 理由 `official_only_limit`
- **thin_unknown 修正（V1）**: 発火条件に「people・works・events がすべて空」を追加する。新条件 = `topic_type==="unknown" ∧ source_count===1 ∧ key_points合計40字未満 ∧ (people+works+events が空)`。2026-07-19 データでの検算: 周星驰路演哽咽・刘宇宁厨艺翻车・群星闪耀时特别放映・郎朗 は通過、身体喜爱藏不住 は引き続き除外
- 「情報不足の記事を最新だからと採用しない」の担保: 情報完全性ゲートと EVS（D/E が低い記事は7点に届かない）の両方が効く。freshness は A 軸の入力であって単独の採用理由にならない

## 6. ソース拡張の実行位置と対象決定

- **位置（P0）**: 現行の実行位置（候補生成直後）のまま動かさない。**対象決定のみ修正する**: 拡張対象を「freshness が today/yesterday/recent の候補」に限定してから newsworthiness_score 順で **上位8件**（env `SOURCE_EXPANSION_MAX_TOPICS`、既定を 3→8 に変更）。クエリは topic あたり**2本**（env `SOURCE_EXPANSION_QUERIES_PER_TOPIC`、既定 1→2）。Serper 無料枠2,500/月に対し 8×2×31日=496/月で十分収まる。stale な高スコア topic（前日再掲候補）が拡張枠を浪費する現状を fresh フィルタで防ぐ
- **位置（P1）**: 情報完全性ゲート・履歴ゲートの**後**、EVS 算定の**前**へ移動し、ゲート通過候補の暫定順位（A軸スコア → japan_gap ヒューリスティック → newsworthiness_score）上位を対象にする（P1-3）
- **RSSHub 403 対策**: env `SOURCE_EXPANSION_SKIP_RSSHUB=true`（新設・既定 false）で RSSHub ルートを試行せず Serper へ直行できるようにする（403 が続く間の無駄な24リクエストと待ち時間を削減。ミラー発見時は false に戻す）。運用推奨値は true とし workflow に設定する
- **転載水増し対策**: expansion evidence の取り込み時（attachExpansionEvidence）に、既存 evidence とのタイトル正規化類似判定を追加し、同内容の転載は evidence に加えても**独立ソースとして数えない**（B軸の独立判定 §2 と同一関数を使う）
- graceful fallback は現行維持: Serper 失敗・キー未設定・全ルート失敗でもパイプラインは続行し、B/C 軸は既存 evidence のみで算定する

## 7. コメント生成 v3 — 「要するに」問題の解消

### 7-1. 説明必要性の判定（deterministic・コメント生成前）

`needs_term_explanation = ledger.terms のうち what_is または why_now が非空で、かつその term が本文（lead+what_happened）に登場するものが1件以上ある`。台帳が無い経路（単段fallback）では false。

### 7-2. 書き出し多様性（deterministic）

- 生成ループが当日生成済みの why_it_matters の書き出し（空白・「」除去後の先頭10字）を蓄積し、コメント工程プロンプトに `used_openings` として渡す
- 生成後検査 `comment_opening_duplicate`: 書き出し10字が当日の他記事と一致 → コメントのみ再生成1回（used_openings を明示して）。再生成後も一致 → warning のまま採用（記事は落とさない）
- 「要するに」も特別扱いせず書き出しの一種として扱う（= 自然に1日1回まで）

### 7-3. 本文言い換え検出（deterministic 近似）

- `comment_paraphrase`: why_it_matters の各文（15字以上）について、本文（lead + what_happened）に対する4字シングル包含率が 0.55 以上なら「言い換え文」。言い換え文が全体の半数以上、または先頭文が言い換え → コメントのみ再生成1回 → 再生成後も該当なら warning のまま採用。閾値は定数化し report:quality で観測して調整する。意味類似度による判定の高度化は P1（P1-4）

### 7-4. コメント工程プロンプト v3（確定形・一字も変えない）

実装済みの `buildBingtangCommentPrompt` のテンプレート本文を次で丸ごと置き換える。`<tone_mode>` 等の挿入方法・violations 追記・末尾入力の付け方は現行構造を踏襲し、入力に `needs_term_explanation` / `angle_hint` / `used_openings` の3項目を追加する:

単段fallback時にも旧型へ戻らないよう、`buildLedgerWritingPrompt` 内の why_it_matters 指示から「要するに何が起きたか」を削除し、本文の言い換えをせず「評価が変わる確認点・今後追う数字や発表・情報源の見方」のいずれかを書く指示へ置換する。

```text
あなたはこのサイトの秘書キャラクター「冰糖（ビンタン）」として、完成した記事本文に付けるコメントを書くAIです。

Editorial character policy document (docs/editorial-character.md):
<editorial文書をここに挿入>

Use the document above as the highest-priority editorial policy.

あなたの仕事:
- 記事本文はすでに完成しています。あなたが書くのは「ビンタンの注目ポイント」（why_it_matters）と「ビンタンからのひとこと」（editor_comment）の2つだけです。
- コメント欄は、本文の言い換え・要約をする場所ではありません。本文に書いていないが、読者の理解や興味に効くことを渡す場所です。
- 本文と事実台帳にある情報だけを使います。新しい数字・人物名・作品名・出来事を足しません。

why_it_matters（ビンタンの注目ポイント）の書き方:
- 入力の needs_term_explanation が true の場合: この記事の中心にある用語・制度の噛み砕き説明を書く。台帳のterms・claimsにある説明だけを使い、一般知識で補完しない。
- needs_term_explanation が false の場合: 用語解説を無理に書かない。本文の内容を言い換えない。かわりに、次のうち記事に最も合う角度を1つ選んで書く:
  1. なぜ今このニュースが気になるのか
  2. 日本語圏から見えにくい点
  3. 次に確認するべき数字・発表・反応
  4. この作品・人物・業界のこれまでの流れとの関係（台帳にある範囲で）
  5. 情報源の見方・注意点（公式発表のみ、単一ソース、SNS由来など）
- 入力に angle_hint がある場合、切り口の参考にしてよい（従う義務はない）。
- lead や what_happened に書いてあることを繰り返さない。読み終えた読者が「なるほど、そこを見ればいいのか」と思える内容にする。
- 書き出しは used_openings にある書き出しと重ならないようにする。
- 抽象的な分析だけで終わらせない。具体的な数字・出来事・確認ポイントを挙げる。
- 100〜250字。一文は50字以内を目安に短く切る。

editor_comment（ビンタンからのひとこと）の書き方:
- 1〜2文。why_it_mattersと同じ内容を繰り返さない。
- 自分（ビンタン）が次に何を見るか、どこが気になるかを軽く言って締める。

口調（トーンモード: <tone_mode>）:
<tone_modeがnormalの場合、次の6行を挿入>
- 明るく、少し前のめりな、話し言葉に近い「です・ます調」。短いくだけた感想を混ぜてよい。
- 使ってよい表現の例: 「〜かも！」「〜みたい！」「すごい！」「これは気になる！」「ちょっと待って！」「ここ、大事です！」「〜なんです！」「〜でしたね〜！」
- 「かも」「みたい」はビンタンの見方・可能性にだけ使う。事実台帳で確認できた事実は、です・ます調で明確に言い切る。
- 「すごい！」「これは気になる！」のような短い感想は、1つのコメント欄につき1回まで。
- 「！」は2つのコメント欄あわせて2〜4個使う。0個にしない。1つの文に2個以上付けない。
- 同じ語尾を続けて使わない。「〜ですね」の多用と、「今後注目したい」型の締めの反復を避ける。
<tone_modeがsoberの場合、次の1行を挿入>
- この話題は重大事件・法的問題・訃報・被害者のいる話題です。「！」を一切使わず、落ち着いた「です・ます調」で書く。軽いツッコミ・くだけた感想・明るい言い回しを使わない。確認できた事実と、まだ分かっていないことの境界をはっきり言う。

禁止事項:
- 「かも」「みたい」「〜のようです」を、台帳のverified_factで確認できている事実に付けない。
- SNSや反応のevidenceが無いのに反応の予想・想像を書かない。
- 台帳で確認できない推測を書かない。
- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」「目が離せません」
- 実在の人物・ファンをからかわない。ツッコミの対象は状況・数字・自分自身のみ。

必ず次のJSONだけを返す:
{
  "why_it_matters": "",
  "editor_comment": "",
  "claim_refs_why_it_matters": []
}

入力:
- topic_key: <topic_key>
- event_sentence: <event_sentence>
- tone_mode: <toneMode>
- needs_term_explanation: <true|false>
- angle_hint: <EVS採点の angle_hint。無ければ「なし」>
- used_openings: <当日すでに使われた書き出しの配列JSON>
- 完成本文:
  lead: <summary.lead>
  what_happened: <summary.what_happened>
  reaction_view: <summary.reaction_view>
  japan_context_note: <summary.japan_context_note>

事実台帳:
<台帳JSON><violations追記><extraInstruction追記>
```

### 7-5. editorial-character.md の差し替え（確定形）

「秘書キャラクター「冰糖（ビンタン）」の適用範囲と口調」セクション内の、現行の次の**7行**（「- 出力セクションのうち…」の行から「- 「〜みたいですね」「〜のようです」は…」の行まで。現状は B1 適用後の文面）を削除し、下のブロックで置換する。**未適用のままの design-review-ui-tone-v2.md §6-2 の差し替えはこの v3 ブロックが supersede する**（U6 の editorial 差し替えは実施せず本節を適用）:

削除する現行7行:

- 「- 出力セクションのうち「ビンタンの注目ポイント」「ビンタンからのひとこと」だけは秘書の声で書く。口調は話し言葉に近い「です・ます調」を基本とし、明るく、少し前のめりに。コメント欄は事実本文を難しく言い換える場所ではなく、難しい中国エンタメの事情を読者に噛み砕いて渡す場所である。タメ口語尾（「〜だね」「〜だよ」等）は使わない。」
- 「- 使ってよい語尾の例: 「〜ですね！」「〜なんです！」「〜ですよ〜！」「〜ですって！」「〜ましたね〜！」「要するに、〜ということです！」」
- 「- 「ビンタンの注目ポイント」の最初の1文は、読者にとって「要するに何が起きているのか」を前提知識ゼロで分かる平易な言葉で言う。抽象的な分析はその後に置く。」
- 「- 一文は短く切る（コメント欄は50字以内目安）。抽象語より具体的な数字・出来事・確認ポイントを優先する。」
- 「- 感嘆符は、通常のエンタメ記事ではコメント欄全体（注目ポイント＋ひとこと）で2〜3個程度を目安に積極的に使う。ただし1つの文に2個以上付けない。重大事件・法的問題・訃報・被害者のいる話題では感嘆符とツッコミを使わず、落ち着いた文体に切り替える。」
- 「- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」」
- 「- 「〜みたいですね」「〜のようです」は伝聞・未確認情報にだけ使う。事実台帳で確認できた事実は言い切る。」

置換ブロック（確定形・一字どおり）:

```markdown
- 出力セクションのうち「ビンタンの注目ポイント」「ビンタンからのひとこと」だけは秘書の声で書く。口調は話し言葉に近い「です・ます調」を基本とし、短いくだけた感想・リアクションを混ぜて明るさを出す。コメント欄は、事実本文を難しく言い換える場所ではなく、本文に書いていないが読者の理解や興味に効くことを渡す場所。タメ口の語尾（「〜だね」「〜だよ」等）で文を終えない。
- 使ってよい表現の例: 「〜かも！」「〜みたい！」「すごい！」「これは気になる！」「ちょっと待って！」「ここ、大事です！」「〜なんです！」「〜でしたね〜！」
- 事実台帳で確認できた事実は、です・ます調で明確に言い切る。「かも」「みたい」「〜のようです」は、ビンタンの見方・可能性・伝聞・未確認情報にだけ使い、確認済みの事実を曖昧にしない。
- 「ビンタンの注目ポイント」は本文の言い換え・要約をしない。用語・背景の説明が必要な記事ではその噛み砕き説明を、不要な記事では「なぜ今気になるか」「日本語圏から見えにくい点」「次に確認する数字・反応」「これまでの流れとの関係」「情報源の見方・注意点」のいずれかを書く。
- 書き出しは記事ごとに変える。同じ書き出しを1日に2回以上使わない。
- 一文は短く切る（コメント欄は50字以内目安）。抽象語より具体的な数字・出来事・確認ポイントを優先する。
- 感嘆符は、通常のエンタメ記事ではコメント欄全体（注目ポイント＋ひとこと）で2〜4個を目安に使う。ただし1つの文に2個以上付けない。0個の場合は書き直しの対象とする。重大事件・法的問題・訃報・被害者のいる話題では感嘆符とツッコミを使わず、落ち着いた文体に切り替える。
- 次のような中身のない定型句を使わない: 「業界全体に影響を与える可能性があります」「透明性向上につながる可能性があります」「今後の動向に注目したいところです」「評価のポイントになりそうです」「新たな指標になるか見守りたいです」
```

### 7-6. 再生成トリガの拡張

`needsCommentRegeneration` に追加: `comment_opening_duplicate`（§7-2）と `comment_paraphrase`（§7-3）。いずれも再生成は1回まで・記事は落とさない。既存の gate（fabricated_reaction 等）・tone 検査・claim/evidence ガードは一切変更しない。

## 8. selection_trace の追加項目

既存診断は壊さず、以下を追加:

```
editorial_value: {
  llm: "ok" | "fallback",
  candidates: [{
    topic_key,
    axes: { freshness_update: {score, reason}, corroboration: {score, reason},
            local_heat: {score, reason}, japan_value: {score, reason},
            bingtang_angle: {score, reason, angle_hint} },
    total, caps: ["single_source_cap" | "single_source_exception:<種別>"],
    result: "qualified" | "evs_below_threshold" | "official_only_limit"
  }]
}
publication_history: {
  loaded_days: [...], entry_count,
  matches: [{ topic_key, matched_date, matched_key, matched_status, reason_tag,
              substantive_update: "none" | "official_decision" | "principal_response" | "result",  // P1で "new_numbers" を追加
              update_evidence_urls: [...], decision: "reselect_allowed" | "dup_no_update" }]  // P1で "cooldown_rejected" | "in_review" を追加
}
official_only: { limit: 1, used: [...], excluded: [...] }
comment_diversity: { openings: [{topic_key, opening}], regenerated_opening: [...], regenerated_paraphrase: [...] }
```

- `topic_selection.dropped` の理由に追加（P0）: `dup_no_update` / `evs_below_threshold` / `official_only_limit`。`cooldown_rejected` / `in_review` は P1 で追加（P0 の履歴除外は `dup_no_update` に統一）
- expansion は既存項目のまま（試行・成功・追加evidence数）＋ ショートリスト対象の topic_key 一覧を追加

## 9. P0 実装タスク（V1〜V12 = 本日実装分。各ステップ後に `npm run check`）

- **V1** thin_unknown 修正（src/completenessGate.ts）。受け入れ: 2026-07-19 の保存済み topic_candidates で 周星驰路演哽咽・刘宇宁厨艺翻车・群星闪耀时特别放映 が通過し、身体喜爱藏不住 が除外される
- **V2** 掲載履歴モジュール（新規 src/publicationHistory.ts）: data/ 過去5日の review.json + articles JSON から履歴構築（P0。fact_ledger の numbers 読込は P1）。ファイル欠落日はスキップ。受け入れ: 2026-07-18/19 の実データから履歴が組み上がり、entities・status・evidence_urls が入る
- **V3** 同一topic判定（src/topicKey.ts に areTopicsLikelySame 追加）＋強い更新判定＋一律 cooldown（src/index.ts。§4 の P0 規則）。受け入れ: 07-18履歴 × 07-19候補の再現で、功夫女足偷票房疑云・微短剧大赛・电视剧发行许可・红色微短剧展・袁娅维=dup_no_update。topic_key が長短2候補に一致する場合は最も具体的な履歴を優先する
- **V4** ソース拡張の対象修正（src/expandSources.ts）: fresh（today/yesterday/recent）候補に限定した上位8件×2クエリ、`SOURCE_EXPANSION_SKIP_RSSHUB` env 追加（位置の再配置は P1-3）。受け入れ: モックで「stale 候補が拡張対象に入らない」「SKIP_RSSHUB=true で RSSHub を試行せず Serper へ直行する」「全滅でも続行する」
- **V5** EVS deterministic 軸（新規 src/editorialValue.ts）: A/B/C・独立ソース判定（転載類似の除外。§2）・cap・例外・理由文字列。受け入れ: §2 の 07-19 検算5ケースがダミーで再現し、同内容の転載が独立ソースに数えられない
- **V6** EVS LLM バッチ（editorialValue.ts 内・プロンプトは §3 確定形）＋ fallback。受け入れ: モック応答で D/E が入り、失敗時 fallback 値と `evs_llm: "fallback"` が trace に出る
- **V7** 選定書き換え（src/index.ts）: 7点ゲート・official-only 1・final_fill の全上限確認・可変本数。受け入れ: 合格5件なら5本で完走（10本へ埋めない）、final_fill 経由でもカテゴリ3本目・official 2本目が出ない
- **V8** trace 追加（src/selectionTrace.ts）: §8 の全項目。既存診断維持。受け入れ: ローカル実行の trace に editorial_value / publication_history / official_only / comment_diversity が出る
- **V9** コメント v3（src/summarizeWithGemini.ts, src/claimCheck.ts）: needs_term_explanation・angle_hint・used_openings の受け渡し、プロンプト差し替え（§7-4 確定形）、opening/paraphrase 検査と再生成、editorial-character.md 差し替え（§7-5 確定形）。受け入れ: ダミーで「書き出し重複→再生成」「言い換え比率超過→再生成」「再生成後も該当→warning採用」が通る。既存の claim/evidence ガード・tone 検査に変更がない
- **V10** report:quality 拡張（src/qualityReport.ts）: EVS 内訳・書き出し一覧と重複・paraphrase warning・履歴一致と更新種別・official-only 数の表示。受け入れ: 07-19 実データ相当のダミーで表が出る
- **V11** workflow 更新（.github/workflows/generate-news.yml）: `SOURCE_EXPANSION_SKIP_RSSHUB=true` と `SOURCE_EXPANSION_MAX_TOPICS=8` を生成ステップ env に追加（SERPER_API_KEY は 988fc27 で配線済み）。受け入れ: yml 差分のみ・他ステップ不変
- **V12** ローカル検証（§10）→ roadmap 更新（実測値1行）→ コミット → push → Actions 実行 → §10 の当日判定セットで合否確認 → レビュー承認 → サイト生成まで本日中に進める

## 10. 検証手順

**ローカル**:

1. 各ステップ後 `npm run check`
2. リプレイ検証（本設計の要）: 保存済み `data/2026-07-18` を履歴、`data/2026-07-19` の topic_candidates を入力として V1〜V7 を通し、§2・§4 の検算ケース（功夫女足偷票房・微短剧大赛・电视剧发行许可・红色微短剧展=dup_no_update / 留几手=cap6 / 备案=例外昇格+official枠 / 周星驰路演哽咽=ゲート通過）を確認（scratchpad スクリプト・コミットしない）
3. `npm run start`（APIキーなし）: EVS LLM が fallback になり、7点ゲートが fallback 値で機能し、trace 新項目が出て既存診断が壊れていないこと
4. コメント検査のダミー（V9 受け入れ）

**Actions(deepseek) 当日判定セット（P0 完了日の合否）**:

当日1回の実行で判定できる項目。全て合格したら P0 完了とし、翌日の実行で下の「2日連続」項目を閉じる。

1. 公開全 topic の EVS ≧7・7点未満の埋め合わせ 0（final_fill 含む）
2. 保存済み前日 topic と一致する再掲 0（強い更新のあるものを除く。publication_history.matches で確認）
3. official-only ≦1・単一ソース単純要約 0（B=0 かつ例外なしの出力 0）
4. why_it_matters の書き出し重複 0・「要するに」開始 ≦1
5. trace に editorial_value（5軸内訳と理由）・publication_history・official_only・comment_diversity が出る
6. 出力本数 = 合格数のまま完走（10未満可）・budget ≦60
7. expansion: SKIP_RSSHUB=true で Serper が試行され success > 0（Serper 側の障害時はこの項目のみ翌日へ持ち越し可。他項目の合否に影響させない）

**Actions(deepseek) 2日連続**:

1. 公開全 topic の EVS ≧7（trace と出力の突合）
2. 7点未満の埋め合わせ採用 0（dropped の evs_below_threshold が出力に不在・final_fill 含む）
3. 実質的更新のない前日 topic の再掲 0（publication_history.matches で確認）
4. official-only ≦1
5. 単一ソース単純要約 0（B=0 かつ例外なしの出力 0）
6. why_it_matters の書き出し重複 0
7. 注目ポイントの本文言い換え warning 0（≦1許容・report:quality）
8. expansion success > 0（Serper 実測）かつ追加 evidence が B/C に反映
9. 複数ソース topic 数 ≧ 直近良好時（07-12 実測2件）
10. 官庁比率 ≦50%・媒体 fresh >0・budget ≦60
11. 出力本数 = 合格数（10未満の日があってよい）

## 11. 後方互換・fallback・脱出ハッチ

| 状況 | 挙動 |
|---|---|
| data/ に過去日の review.json / articles / fact_ledger が無い | その日をスキップして履歴構築（履歴0日でも動作＝全候補が「新規」扱い） |
| EVS LLM バッチ失敗 | D/E をヒューリスティック fallback（trace 明示）。7点ゲートは維持 |
| Serper 失敗・キー未設定 | 既存 evidence のみで B/C 算定・続行 |
| RSSHub 403 継続 | SKIP_RSSHUB=true で回避（ルート定義は残す） |
| 単段 fallback 経路（台帳なし） | needs_term_explanation=false・angle_hint なしでコメント v3 動作 |
| `EDITORIAL_VALUE_GATE=false`（新設） | EVS 算定・7点ゲート・official-only 上限・履歴ゲートを無効化し v2 選定へ戻す（緊急時の脱出ハッチ。trace に disabled を記録） |
| 旧 trace の読み手 | 既存フィールドは全て維持（追加のみ） |

## 12. やらないこと

- newsworthiness_score の再設計（供給診断用として現状維持。EVS と役割分離）
- レビューUI の操作変更・サイト側の変更
- 却下理由からの自動ロジック変更（cooldown は status/tag のみ使用。自由記述コメントの解釈はしない）
- analysis_feature 解禁（3c）
- topicKey 生成ロジックの変更（追加するのは比較関数のみ）

## 13. P1 タスク（後日・優先順）

- **P1-1 弱い更新（new_numbers）判定**: publicationHistory に fact_ledger の numbers を読み込み、claimCheck の正規化で新 evidence の数字との差分を判定。approved 履歴のみ弱い更新（A=1）で再掲可にする
- **P1-2 reason_tag 別 cooldown**: §4 の P1 テーブルを導入（選定却下=強い更新のみ・品質却下=approved 同等・revision/pending=in_review 除外）。trace の decision に cooldown_rejected / in_review を追加
- **P1-3 ソース拡張のゲート後再配置**: §6 の P1 位置へ移動。ゲート通過候補の暫定順位上位を対象化し、拡張結果を B/C 軸へ直結する
- **P1-4 コメント類似度判定の高度化**: 4字シングル法の実測（report:quality の warning 率）を2週間観察してから、意味類似の追加要否を判断する。安易に LLM 判定を足さない
- **P1-5 スコア配点の長期見直し**: review-feedback.jsonl の採否と EVS の突合を月次で行い、軸の配点・cap を人間判断で調整する（自動学習はしない）

P1 着手の前提: P0 の「2日連続」受け入れが完了していること。
