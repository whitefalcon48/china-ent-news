import { inspectDisplayKanjiResidues } from "../displayKanji.js";
import {
  extractNormalizedClaimNumberTokens,
  extractNumberTokens,
  normalizeNumberToken,
  runClaimCheck,
  runCommentCheck
} from "../claimCheck.js";
import { getToneMode } from "../toneMode.js";
import { assertToneOnlyRevisionContract } from "../toneOnlyRevision.js";
import type {
  ClaimCheckResult,
  FactLedger,
  ReviewPatchDocument,
  ReviewPatchOperation,
  ReviewPatchableField,
  ReviewReasonTag,
  ReviewRevisionIntent,
  ReviewRevisionTrace,
  SummarizedArticle,
  TopicCandidate
} from "../types.js";

const TOP_LEVEL_FIELDS = [
  "title_ja",
  "lead",
  "what_happened",
  "reaction_view",
  "why_it_matters",
  "japan_context_note"
] as const satisfies readonly ReviewPatchableField[];

const FIELD_ALIASES: Array<{ pattern: RegExp; fields: Array<(typeof TOP_LEVEL_FIELDS)[number]> }> = [
  { pattern: /(?:タイトル|見出し|title_ja)/u, fields: ["title_ja"] },
  { pattern: /(?:リード|導入|lead)/u, fields: ["lead"] },
  { pattern: /(?:本文|何が起きた|what_happened)/u, fields: ["what_happened"] },
  { pattern: /(?:反応・見られ方|reaction_view|SNS反応|微博の反応)/u, fields: ["reaction_view"] },
  { pattern: /(?:ビンタンの注目ポイント|注目ポイント|why_it_matters)/u, fields: ["why_it_matters"] },
  { pattern: /(?:ビンタンからの補足|補足|japan_context_note)/u, fields: ["japan_context_note"] }
];

const FULL_REWRITE = /(?:全文|記事全体|全体|全体の本文).{0,18}(?:書き直|作り直|再生成|再構成|リライト)|(?:記事|本文).{0,10}(?:全面的に|すべて|全部).{0,8}(?:書き直|作り直|再生成|再構成|リライト)|(?:完全|全面)(?:再生成|リライト)|構成.{0,10}(?:作り直|再構成)/u;
const SHORTENING_REQUEST = /(?:削除|短く|簡潔|要約|圧縮)/u;
const FIELD_REWRITE_REQUEST = /(?:再構成|再編|組み直|書き直|作り直|リライト|再生成)/u;
const LITERAL_ARROW_REPLACEMENT = /(?:^|[\s、。．,，；;！？!?])(?:「([^」\r\n]{1,80})」|『([^』\r\n]{1,80})』|“([^”\r\n]{1,80})”|"([^"\r\n]{1,80})"|([^→⇒\r\n\s、。．,，；;！？!?]{1,80}?))\s*(?:→|⇒|->)\s*(?:「([^」\r\n]{1,80})」|『([^』\r\n]{1,80})』|“([^”\r\n]{1,80})”|"([^"\r\n]{1,80})"|([^\r\n\s、。．,，；;！？!?]{1,80}))/gu;

export class ReviewRevisionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRevisionContractError";
  }
}

export class ReviewRevisionClarificationRequiredError extends ReviewRevisionContractError {
  readonly code = "clarification_required";

  constructor(message: string) {
    super(message);
    this.name = "ReviewRevisionClarificationRequiredError";
  }
}

export type ReviewFieldRewriteRepairReason = "same_after" | "superficial_rewrite";

export type ReviewFieldRewriteRepairFeedback = {
  field: ReviewPatchableField;
  reason: ReviewFieldRewriteRepairReason;
};

type ReviewIntentOptions = {
  /**
   * A mixed instruction has already had its exact A→B operations removed.
   * In that residual, words such as "タイトルの意味" are facts to add, not a
   * request to edit the title. Only a grammatical destination is editable.
   */
  directDestinationOnly?: boolean;
};

export type MixedLiteralRevisionPlan = {
  originalIntent: ReviewRevisionIntent;
  residualIntent: ReviewRevisionIntent;
  combinedIntent: ReviewRevisionIntent;
  workingSummary: SummarizedArticle;
  deterministicPatches: ReviewPatchOperation[];
  residualInstruction: string;
};

/**
 * A required field rewrite reached a safe, evidence-backed scope, but the
 * generated text did not actually rewrite the field. The caller may make one
 * bounded repair attempt; without that caller this remains a clarification.
 */
export class ReviewRevisionFieldRewriteRepairableError extends ReviewRevisionClarificationRequiredError {
  constructor(
    readonly field: ReviewPatchableField,
    readonly repairReason: ReviewFieldRewriteRepairReason
  ) {
    super(repairReason === "same_after"
      ? `再構成の変更後が現在値と同じです: ${field}`
      : `再構成が既存文への薄い追記・言い換えに留まっています: ${field}`);
    this.name = "ReviewRevisionFieldRewriteRepairableError";
  }
}

export function detectReviewRevisionIntent(
  summary: SummarizedArticle,
  instruction: string,
  reasonTag: ReviewReasonTag | string = "その他",
  options: ReviewIntentOptions = {}
): ReviewRevisionIntent {
  if (FULL_REWRITE.test(instruction)) {
    return {
      mode: "full_rewrite",
      allowed_fields: listPatchableFields(summary),
      explicit_fields: listPatchableFields(summary),
      anchors_by_field: {},
      required_replacements: [],
      required_field_rewrites: [],
      clarification_reason: ""
    };
  }

  const explicitFields = options.directDestinationOnly
    ? detectDirectDestinationFields(instruction)
    : detectNamedFields(instruction);
  if (/(?:詳しく見る|詳細セクション|detail_sections)/u.test(instruction)) {
    (summary.detail_sections ?? []).forEach((_section, index) => {
      explicitFields.add(`detail_sections.${index}.heading`);
      explicitFields.add(`detail_sections.${index}.body`);
    });
  }
  if (reasonTag === "口調" && explicitFields.size === 0) explicitFields.add("why_it_matters");

  const replacementDetection = detectRequiredLiteralReplacements(summary, instruction);
  if (replacementDetection.unsafe.length > 0) {
    return {
      mode: "clarification_required",
      allowed_fields: [],
      explicit_fields: [...explicitFields],
      anchors_by_field: {},
      required_replacements: replacementDetection.requirements,
      required_field_rewrites: [],
      clarification_reason: `明示置換どうしが重なり、適用順で結果が変わります: ${replacementDetection.unsafe.join(", ")}`
    };
  }
  if (replacementDetection.unmatched.length > 0) {
    return {
      mode: "clarification_required",
      allowed_fields: [],
      explicit_fields: [...explicitFields],
      anchors_by_field: {},
      required_replacements: replacementDetection.requirements,
      required_field_rewrites: [],
      clarification_reason: `明示置換の修正元が記事内に見つかりませんでした: ${replacementDetection.unmatched.join(", ")}`
    };
  }

  const requiredFieldRewrites = detectRequiredFieldRewrites(summary, instruction);
  const candidateAnchors = [
    ...extractInstructionAnchors(summary, instruction),
    ...replacementDetection.requirements.map((replacement) => replacement.before)
  ];
  const anchorsByField: Partial<Record<ReviewPatchableField, string[]>> = {};
  const allowedFields = new Set<ReviewPatchableField>(explicitFields);
  for (const field of listPatchableFields(summary)) {
    const value = readPatchableField(summary, field);
    const matches = candidateAnchors.filter((anchor) => value.includes(anchor));
    if (matches.length > 0) {
      if (!options.directDestinationOnly || allowedFields.has(field)) {
        anchorsByField[field] = [...new Set(matches)];
      }
      // In a residual of a mixed instruction, a quoted fact may mention a
      // title/person/work. It must not silently widen the model's edit scope.
      if (!options.directDestinationOnly) allowedFields.add(field);
    }
  }

  if (allowedFields.size === 0) {
    return {
      mode: "clarification_required",
      allowed_fields: [],
      explicit_fields: [],
      anchors_by_field: {},
      required_replacements: replacementDetection.requirements,
      required_field_rewrites: requiredFieldRewrites,
      clarification_reason: "修正対象のフィールドまたは元記事内の完全一致箇所を特定できませんでした"
    };
  }

  return {
    mode: "limited_patch",
    allowed_fields: [...allowedFields],
    explicit_fields: [...explicitFields],
    anchors_by_field: anchorsByField,
    required_replacements: replacementDetection.requirements,
    required_field_rewrites: requiredFieldRewrites,
    clarification_reason: ""
  };
}

/**
 * Split a mixed request into deterministic lexical replacements and the
 * remaining editorial request. Nothing is persisted here: callers validate
 * the composed proposal against the immutable original before saving it.
 */
export function planMixedLiteralRevision(
  before: SummarizedArticle,
  instruction: string,
  reasonTag: ReviewReasonTag | string = "その他"
): MixedLiteralRevisionPlan | null {
  const originalIntent = detectReviewRevisionIntent(before, instruction, reasonTag);
  if (
    originalIntent.mode !== "limited_patch"
    || originalIntent.required_replacements.length === 0
    || isOnlyLiteralReplacementInstruction(instruction)
  ) return null;

  const staged = applyRequiredLiteralReplacements(before, originalIntent);
  if (!staged) return null;
  const residualInstruction = removeLiteralReplacementSpans(instruction).trim();
  const residualIntent = {
    ...detectReviewRevisionIntent(staged.summary, residualInstruction, reasonTag, { directDestinationOnly: true }),
    // A mixed request is a lexical replacement plus a prose addition, never
    // an implicit field rewrite. The latter must be a separately explicit
    // request so it cannot erase the deterministic stage.
    required_field_rewrites: [],
    restrict_full_field_replacement: true,
    require_claim_refs_for_prose: mixedResidualNeedsClaimRefs(residualInstruction, reasonTag),
    protected_replacements: originalIntent.required_replacements.flatMap((replacement) => (
      replacement.target_fields.map((field) => ({ field, literal: replacement.after }))
    ))
  };
  if (residualIntent.mode === "clarification_required") {
    throw new ReviewRevisionClarificationRequiredError(residualIntent.clarification_reason);
  }
  const deterministicFields = new Set(staged.patches.map((patch) => patch.field));
  return {
    originalIntent,
    residualIntent,
    combinedIntent: {
      ...residualIntent,
      allowed_fields: [...new Set([...residualIntent.allowed_fields, ...deterministicFields])],
      explicit_fields: [...new Set([...residualIntent.explicit_fields, ...deterministicFields])],
      required_replacements: originalIntent.required_replacements
    },
    workingSummary: staged.summary,
    deterministicPatches: staged.patches,
    residualInstruction
  };
}

function mixedResidualNeedsClaimRefs(instruction: string, reasonTag: ReviewReasonTag | string) {
  const factualDestination = /(?:タイトル|見出し|リード|導入|本文|何が起きた|what_happened|反応・見られ方|reaction_view|SNS反応|微博の反応|ビンタンの注目ポイント|注目ポイント|why_it_matters|ビンタンからの補足|補足|japan_context_note)/u;
  if (!factualDestination.test(instruction)) return false;
  const deletionOnly = /(?:削除|消(?:して|す|し)|取り除|外して)/u.test(instruction);
  const explicitAddition = /(?:追加|追記|補(?:って|い|う|足)|書き加え|入れ|記載)/u;
  if (deletionOnly && !explicitAddition.test(instruction)) return false;
  const proseAddition = /(?:追加|追記|補(?:って|い|う|足)|書き加え|入れ|記載|説明|解説|明か|語った|理由|意味|背景)/u;
  if (!proseAddition.test(instruction)) return false;
  const explicitlyToneOnly = reasonTag === "口調" && /(?:口調|語尾|言い回し|表現|トーン)/u.test(instruction)
    && !/(?:事実|根拠|説明|解説|明か|語った|理由|意味|背景)/u.test(instruction);
  return !explicitlyToneOnly;
}

export function tryApplyDeterministicTerminologyReplacement(
  before: SummarizedArticle,
  instruction: string,
  reasonTag: ReviewReasonTag | string,
  intent: ReviewRevisionIntent
): { summary: SummarizedArticle; trace: ReviewRevisionTrace } | null {
  if (
    intent.mode !== "limited_patch"
    || intent.required_replacements.length === 0
    || intent.required_field_rewrites.length > 0
    || !isOnlyLiteralReplacementInstruction(instruction)
  ) return null;

  const staged = applyRequiredLiteralReplacements(before, intent);
  if (!staged) return null;
  assertNoNewDisplayResidues(before, staged.summary);
  return {
    summary: staged.summary,
    trace: buildReviewRevisionTrace(before, staged.summary, staged.patches, intent, instruction)
  };
}

function applyRequiredLiteralReplacements(before: SummarizedArticle, intent: ReviewRevisionIntent) {
  let after = structuredClone(before);
  const patches: ReviewPatchOperation[] = [];
  for (const field of [...new Set(intent.required_replacements.flatMap((replacement) => replacement.target_fields))]) {
    const original = readPatchableField(after, field);
    let next = original;
    for (const replacement of intent.required_replacements.filter((item) => item.target_fields.includes(field))) {
      if (!sameNumberTokens(replacement.before, replacement.after)) return null;
      next = next.split(replacement.before).join(replacement.after);
    }
    if (next === original) return null;
    // One staged patch per field preserves the exact, all-occurrence coverage
    // even when a term appears more than once in that field.
    patches.push({
      field,
      operation: "replace",
      before: original,
      after: next,
      evidence_claim_refs: [],
      reason: "OWNERが明示した用語を全出現へ限定置換"
    });
    after = writePatchableField(after, field, next);
  }
  return patches.length > 0 ? { summary: after, patches } : null;
}

function removeLiteralReplacementSpans(instruction: string) {
  const normalized = normalizeHtmlEncodedArrows(instruction);
  const matches = [...normalized.matchAll(LITERAL_ARROW_REPLACEMENT)]
    .filter((match) => firstCaptured(match.slice(1, 6)) && firstCaptured(match.slice(6, 11)));
  if (matches.length === 0) return normalized;
  let cursor = 0;
  let residual = "";
  for (const match of matches) {
    const start = match.index ?? 0;
    residual += normalized.slice(cursor, start);
    // Keep a boundary so adjacent natural-language clauses never merge.
    residual += " ";
    cursor = start + match[0].length;
  }
  return residual + normalized.slice(cursor);
}

function isOnlyLiteralReplacementInstruction(instruction: string) {
  const remainder = normalizeHtmlEncodedArrows(instruction)
    // Human-facing labels are not extra edits.  They are common in a natural
    // numbered request such as "作品名は A → B".
    .replace(/(?:作品名|タイトル|用語)(?:は|を)?/gu, "")
    .replace(LITERAL_ARROW_REPLACEMENT, "")
    // These are execution words, not a second creative instruction.  Keep
    // this list deliberately closed so additions/rephrasing still become a
    // proposal instead of a silent partial edit.
    .replace(/(?:に|へ)(?:直して|修正して|変更して|統一して)ください/gu, "")
    .replace(/[\s、。．,，；;！？!?]/gu, "");
  return remainder.length === 0;
}

function sameNumberTokens(before: string, after: string) {
  return [...normalizedNumberTokens(before)].sort().join("\u0000") === [...normalizedNumberTokens(after)].sort().join("\u0000");
}

export function buildLimitedReviewPatchPrompt(
  summary: SummarizedArticle,
  ledger: FactLedger,
  instruction: string,
  intent: ReviewRevisionIntent,
  repairFeedback?: ReviewFieldRewriteRepairFeedback
) {
  const allowedContent = Object.fromEntries(intent.allowed_fields.map((field) => [field, readPatchableField(summary, field)]));
  const usableClaims = ledger.claims.filter(isUsableReviewClaim);
  const protectedLiteralInstruction = intent.protected_replacements?.length
    ? `\n決定的置換済みの保護語句（この語句を before に含めて変更・削除してはいけません）:\n${JSON.stringify([...new Set(intent.protected_replacements.map((item) => item.literal))], null, 2)}\n`
    : "";
  const repairInstruction = repairFeedback ? `

前回案の検証失敗（今回が唯一の修復機会）:
${JSON.stringify(repairFeedback, null, 2)}

- 前回は required field rewrite の after が現在値と同じか、既存文への薄い追記・言い換えでした。同じ after を再利用しないでください。
- 上記フィールドは、利用可能claim同士の関係が分かる新しい構成・文順で、フィールド全体を書き直してください。
- 修復出力もOWNER指示の全件を含む完全な限定パッチJSONにしてください。明示置換など他の必須patchを省略してはいけません。
- 修復できなければ、推測や薄い変更で埋めず clarification_required=true にしてください。` : "";
  return `あなたは保存済み記事への限定修正パッチを作ります。記事全文を再生成してはいけません。

修正指示:
${instruction}

変更可能フィールド:
${JSON.stringify(intent.allowed_fields)}

変更可能フィールドの現在値:
${JSON.stringify(allowedContent, null, 2)}

元記事内で検出した完全一致アンカー:
${JSON.stringify(intent.anchors_by_field, null, 2)}

省略禁止の明示置換（target_fields の全出現を処理）:
${JSON.stringify(intent.required_replacements, null, 2)}

フィールド全体の実質的な再構成が必要な箇所:
${JSON.stringify(intent.required_field_rewrites, null, 2)}

利用可能な事実台帳（claims は evidence_claim_refs に指定できるものだけ）:
${JSON.stringify({ claims: usableClaims, terms: ledger.terms }, null, 2)}
${protectedLiteralInstruction}
${repairInstruction}

厳守事項:
- 出力は記事全文ではなく、次の限定パッチJSONだけにする。
- field は変更可能フィールドからだけ選ぶ。
- 通常は operation="replace" とし、before は現在値に1回だけ現れる完全一致文字列にする。対象箇所以外の文を before に含めない。
- 省略禁止の明示置換は、指定された全組を target_fields の全出現へ反映する。一部だけ処理して成功扱いにしてはいけない。OWNERが before→after を明示した純粋な用語置換には根拠claimが不要なので、evidence_claim_refs=[] にする。元の語を含むclaimを探して付けてはいけない。
- operation="replace_field" は、修正指示がそのフィールド全体を明示した場合だけ使う。上記の「実質的な再構成が必要な箇所」には必ず replace_field を使い、before は空文字にする。保存記事の実際の現在値はシステムがbindするため、長文をコピー・要約・補正してbeforeへ入れてはいけない。afterにはフィールド全体の書き直し後を入れる。
- replace_field の after に現在値と同じ文を返してはいけない。同文は修正未実施として拒否される。
- 通常の置換では、after は修正指示に必要な最小限の変更だけにし、周辺文、別フィールド、文順を変えない。
- 決定的置換済みの保護語句が示されている場合、その語句を before に含めて変更・削除してはいけない。追記は保護語句を含まない一意の文を before にして行う。
- 再構成対象フィールドには最小変更ルールを適用しない。既存文の前後へ説明を1文足すだけ、ほぼ同じ文順・表現を残すだけでは不合格。指示された分かりにくさ・浅さを解消するよう、根拠claim同士の因果・対比・仕組み・変化のいずれかを説明する文章へ組み直す。
- 再構成の evidence_claim_refs には、上の「利用可能な事実台帳」にあるclaim IDから、書き直したフィールドで実際に使ったものをすべて入れる。表示されていないIDやunsupported claimは使わない。根拠から実質的な改善を作れない場合は、薄い追記で済ませず clarification_required=true にする。
- why_it_matters の再構成では、あらすじの追加だけで終わらせず、なぜ再評価・注目が起きるのか、作品や出来事の何が面白い／重要なのかを、事実台帳にある複数事実の関係として説明する。台帳に無い評論を足さない。
- 日付、金額、人数、回数などの数字表現を追加・訂正する場合は、その数字を本文またはnumbersに持つ claim ID を evidence_claim_refs に入れる。アラビア数字だけでなく「二人」「三回」等の漢数字も同じ扱いとし、人物名の数から人数を作らない。根拠が無ければ変更せず clarification_required=true にする。
- 中国語の原語が指示に含まれていても、公表する after には簡体字を残さず、日本語用漢字と自然な日本語説明にする。
- 元が空の reaction_view に、指示されていないSNS反応・引用・一般化を追加しない。
- source_list、related_sources、非対象フィールド、非対象のclaim refsは変更対象にできない。
- 安全に限定できない、複数箇所のどれか判別できない、根拠が足りない場合は patches=[] とし clarification_required=true にする。

JSON形状:
{
  "mode": "limited_patch",
  "clarification_required": false,
  "clarification_reason": "",
  "patches": [
    {
      "field": "what_happened",
      "operation": "replace",
      "before": "現在値に1回だけある文字列",
      "after": "訂正後の文字列",
      "evidence_claim_refs": [],
      "reason": "変更概要"
    }
  ]
}`;
}

export function normalizeReviewPatchDocument(value: unknown): ReviewPatchDocument {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (input.mode !== "limited_patch") throw new ReviewRevisionContractError("限定パッチの mode が不正です");
  const rawPatches = Array.isArray(input.patches) ? input.patches : [];
  const patches = rawPatches.map((raw, index) => normalizePatchOperation(raw, index));
  return {
    mode: "limited_patch",
    clarification_required: input.clarification_required === true,
    clarification_reason: typeof input.clarification_reason === "string" ? input.clarification_reason.trim() : "",
    patches
  };
}

export function applyValidatedReviewPatch(
  before: SummarizedArticle,
  topic: TopicCandidate,
  ledger: FactLedger,
  instruction: string,
  reasonTag: ReviewReasonTag | string,
  intent: ReviewRevisionIntent,
  document: ReviewPatchDocument,
  validationBefore: SummarizedArticle = before
): { summary: SummarizedArticle; trace: ReviewRevisionTrace; claimCheck: ClaimCheckResult; patches: ReviewPatchOperation[] } {
  if (intent.mode === "clarification_required") {
    throw new ReviewRevisionClarificationRequiredError(intent.clarification_reason);
  }
  if (intent.mode !== "limited_patch") throw new ReviewRevisionContractError("限定修正ではないintentをpatch mergeへ渡せません");
  if (document.clarification_required) {
    throw new ReviewRevisionClarificationRequiredError(document.clarification_reason || "安全に限定できる修正パッチを作れませんでした");
  }
  if (document.patches.length === 0) {
    throw new ReviewRevisionClarificationRequiredError("修正対象を特定できるパッチが返りませんでした");
  }

  const allowed = new Set(intent.allowed_fields);
  const explicit = new Set(intent.explicit_fields);
  const knownClaims = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  const patches = bindRequiredFieldRewriteBefore(
    before,
    prepareReviewPatchEvidenceRefs(document.patches, intent, ledger, reasonTag),
    intent
  );
  const originalFieldValues = new Map(listPatchableFields(before).map((field) => [field, readPatchableField(before, field)]));
  const replacedChars = new Map<ReviewPatchableField, number>();
  let after = structuredClone(before);

  for (const patch of patches) {
    if (!allowed.has(patch.field)) throw new ReviewRevisionContractError(`許可されていないフィールドです: ${patch.field}`);
    const current = readPatchableField(after, patch.field);
    const original = originalFieldValues.get(patch.field) ?? "";
    const fullFieldRewriteAllowed = !intent.restrict_full_field_replacement || intent.required_field_rewrites.includes(patch.field);
    const protectedLiteral = intent.protected_replacements?.find((item) => item.field === patch.field && patch.before.includes(item.literal));
    if (protectedLiteral) {
      throw new ReviewRevisionContractError(`決定的置換済みの語句を後段パッチが変更しようとしています: ${patch.field}`);
    }
    if (patch.operation === "replace_field") {
      if (!explicit.has(patch.field) || !fullFieldRewriteAllowed) throw new ReviewRevisionContractError(`フィールド全体の置換は明示された再構成対象だけに許可されます: ${patch.field}`);
      if (patch.before !== current) throw new ReviewRevisionContractError(`replace_field の before が現在値と一致しません: ${patch.field}`);
    } else {
      if (!patch.before) throw new ReviewRevisionContractError(`replace の before は空にできません: ${patch.field}`);
      const occurrences = countOccurrences(current, patch.before);
      if (occurrences !== 1) throw new ReviewRevisionContractError(`before は現在値に1回だけ必要です: ${patch.field} (${occurrences}回)`);
      if (!explicit.has(patch.field)) {
        const anchors = intent.anchors_by_field[patch.field] ?? [];
        if (!anchors.some((anchor) => patch.before.includes(anchor))) {
          throw new ReviewRevisionContractError(`検出済みアンカーを含まない変更です: ${patch.field}`);
        }
      }
      const total = (replacedChars.get(patch.field) ?? 0) + patch.before.length;
      replacedChars.set(patch.field, total);
      const pureAddition = patch.after.startsWith(patch.before) || patch.after.endsWith(patch.before);
      if (original.length > 0 && total / original.length > 0.65 && !fullFieldRewriteAllowed && !pureAddition) {
        throw new ReviewRevisionContractError(`限定修正の範囲を超えて本文を置換しようとしています: ${patch.field}`);
      }
    }
    for (const ref of patch.evidence_claim_refs) {
      const claim = knownClaims.get(ref);
      if (!claim || !isUsableReviewClaim(claim)) throw new ReviewRevisionContractError(`利用できない根拠claimです: ${ref}`);
    }
    const factualProseField = /^(?:title_ja|lead|what_happened|reaction_view|why_it_matters|japan_context_note)$/u.test(patch.field);
    if ((reasonTag === "事実" || (intent.require_claim_refs_for_prose && factualProseField)) && patch.evidence_claim_refs.length === 0) {
      throw new ReviewRevisionContractError(`事実訂正に根拠claimがありません: ${patch.field}`);
    }
    assertNewNumbersGrounded(patch, ledger);
    if (patch.before === patch.after) {
      if (patch.operation === "replace_field" && intent.required_field_rewrites.includes(patch.field)) {
        assertLedgerCanSupportFieldRewrite(patch.field, ledger);
        throw new ReviewRevisionFieldRewriteRepairableError(patch.field, "same_after");
      }
      throw new ReviewRevisionContractError(`変更前後が同じです: ${patch.field}`);
    }
    const next = patch.operation === "replace_field" ? patch.after : current.replace(patch.before, patch.after);
    after = writePatchableField(after, patch.field, next);
    after = addPatchClaimRefs(after, patch.field, patch.evidence_claim_refs);
  }

  assertRequiredInstructionCoverage(before, after, patches, intent, ledger);
  if (reasonTag === "口調") assertToneOnlyRevisionContract(before, after);
  const trace = buildReviewRevisionTrace(before, after, patches, intent, instruction);
  assertNoNewDisplayResidues(validationBefore, after);
  const beforeClaimCheck = runClaimCheck(validationBefore, ledger);
  const afterClaimCheck = runClaimCheck(after, ledger);
  assertNoNewGates(beforeClaimCheck, afterClaimCheck, "記事claim check");
  const toneMode = getToneMode(topic, ledger);
  const beforeComment = runCommentCheck(validationBefore.why_it_matters, "", ledger, topic, toneMode, {
    bodyText: articleBodyText(validationBefore),
    bodyClaimRefs: articleBodyClaimRefs(validationBefore),
    commentClaimRefs: validationBefore.claim_refs.why_it_matters
  });
  const afterComment = runCommentCheck(after.why_it_matters, "", ledger, topic, toneMode, {
    bodyText: articleBodyText(after),
    bodyClaimRefs: articleBodyClaimRefs(after),
    commentClaimRefs: after.claim_refs.why_it_matters
  });
  assertNoNewGates({ ...beforeClaimCheck, violations: beforeComment }, { ...afterClaimCheck, violations: afterComment }, "コメントclaim check");
  return { summary: after, trace, claimCheck: afterClaimCheck, patches };
}

function extractInstructionAnchors(summary: SummarizedArticle, instruction: string) {
  const values = listPatchableFields(summary).map((field) => readPatchableField(summary, field));
  const quoted = [...instruction.matchAll(/[「『“"]([^」』”"]{2,})[」』”"]/gu)].map((match) => match[1].trim());
  const originalTokens = values.flatMap((value) => value.match(/\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d+(?:\.\d+)?(?:億|亿|万)?元(?:以上|相当)?|\d+人(?:の[^、。]{0,12})?/gu) ?? []);
  return [...new Set([...quoted, ...originalTokens.filter((token) => instruction.includes(token))])]
    .filter((anchor) => values.some((value) => value.includes(anchor)));
}

function detectNamedFields(instruction: string) {
  const fields = new Set<ReviewPatchableField>();
  for (const alias of FIELD_ALIASES) {
    if (alias.pattern.test(instruction)) alias.fields.forEach((field) => fields.add(field));
  }
  return fields;
}

function detectDirectDestinationFields(instruction: string) {
  const fields = new Set<ReviewPatchableField>();
  const destinationVerb = /(?:追加|追記|補(?:って|い|う|足)|書き加え|入れ|記載|直(?:して|す|し)|修正|変更|置換|削除|消(?:して|す|し)|取り除|外(?:して|す|し))/u;
  const destinationAction = /(?:追加|追記|補(?:って|い|う|足)|書き加え|入れ|記載|直(?:して|す|し)|修正|変更|置換|削除|消(?:して|す|し)|取り除|外(?:して|す|し))(?:しない|せず|しません|不要|する必要はない|しなくてよい|するな)?/u;
  for (const clause of splitDestinationClauses(instruction)) {
    for (const alias of FIELD_ALIASES) {
      // A field is a destination only when it is followed by a destination
      // particle. "タイトルの具体的な意味" is content, not title_ja scope.
      const destination = new RegExp(`(${alias.pattern.source})(?:か)?[」』]?(?:欄)?\\s*(に|へ|を|から)`, "gu");
      for (const match of clause.matchAll(destination)) {
        const tail = clause.slice((match.index ?? 0) + match[0].length);
        // Bind the action to this destination. A following positive action in
        // another comma clause must not override "タイトルを修正せず".
        const action = destinationAction.exec(tail)?.[0] ?? "";
        if (!action || !destinationVerb.test(action)) continue;
        if (/(?:しない|せず|しません|不要|する必要はない|しなくてよい|するな)$/u.test(action)) continue;
        const directlyAttached = tail.trimStart().startsWith(action);
        const particle = match[2] ?? "";
        const start = match.index ?? 0;
        const quotedUiLabel = /[「『“"]/u.test(clause.slice(Math.max(0, start - 1), start + match[0].length));
        const columnLabel = match[0].includes("欄");
        const safeDistantDestination = alias.fields.includes("what_happened") || quotedUiLabel || columnLabel;
        // 「タイトルを参考にして、本文に追記」のように、対象を
        // 説明材料として使うだけの `を` は編集対象にしない。distant
        // additions are reserved for a body/UI label, never a bare semantic
        // mention such as「タイトルに込めた意味」.
        if (!directlyAttached && (particle === "を" || !safeDistantDestination)) continue;
        alias.fields.forEach((field) => fields.add(field));
      }
    }
    if (/(?:詳しく見る|詳細セクション|detail_sections)\s*(?:に|へ|を)/u.test(clause)) {
      // Detail sections still require an explicit field/section choice; do
      // not widen all of them merely because the request says "details".
    }
  }
  return fields;
}

function splitDestinationClauses(instruction: string) {
  const closingByOpening: Record<string, string> = { "「": "」", "『": "』", "“": "”", '"': '"' };
  let closing = "";
  let protectedInstruction = "";
  for (const char of instruction) {
    if (closing) {
      if (char === closing) closing = "";
      protectedInstruction += char === "。" ? "\uE000" : char;
      continue;
    }
    closing = closingByOpening[char] ?? "";
    protectedInstruction += char;
  }
  return protectedInstruction
    .split(/[。．；;！？!?\r\n]+/u)
    .map((value) => value.replace(/\uE000/gu, "。").trim())
    .filter(Boolean);
}

function detectRequiredLiteralReplacements(summary: SummarizedArticle, instruction: string) {
  const normalizedInstruction = normalizeHtmlEncodedArrows(instruction);
  const candidates = [...normalizedInstruction.matchAll(LITERAL_ARROW_REPLACEMENT)].map((match) => ({
    before: firstCaptured(match.slice(1, 6)),
    after: firstCaptured(match.slice(6, 11))
  })).filter((item) => item.before && item.after && item.before !== item.after);
  const unique = candidates.filter((candidate, index) => candidates.findIndex((item) => (
    item.before === candidate.before && item.after === candidate.after
  )) === index);
  const unmatched: string[] = [];
  const requirements = unique.map((candidate) => {
    const targetFields = listPatchableFields(summary).filter((field) => readPatchableField(summary, field).includes(candidate.before));
    if (targetFields.length === 0) unmatched.push(`${candidate.before}→${candidate.after}`);
    return { ...candidate, target_fields: targetFields };
  });
  const unsafe = unique.flatMap((candidate, index) => unique.slice(index + 1).flatMap((other) => {
    if (
      candidate.after.includes(other.before)
      || other.after.includes(candidate.before)
      || hasNonEmptySuffixPrefixOverlap(candidate.before, other.before)
      || hasNonEmptySuffixPrefixOverlap(other.before, candidate.before)
      || hasNonEmptySuffixPrefixOverlap(candidate.after, other.before)
      || hasNonEmptySuffixPrefixOverlap(other.after, candidate.before)
    ) {
      return [`${candidate.before}→${candidate.after} / ${other.before}→${other.after}`];
    }
    return [];
  }));
  return { requirements, unmatched, unsafe: [...new Set(unsafe)] };
}

function hasNonEmptySuffixPrefixOverlap(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  for (let length = 1; length <= max; length += 1) {
    if (left.slice(-length) === right.slice(0, length)) return true;
  }
  return false;
}

function normalizeHtmlEncodedArrows(instruction: string) {
  return instruction.replace(/-&(?:amp;)*gt;/gu, "->");
}

function firstCaptured(values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function detectRequiredFieldRewrites(summary: SummarizedArticle, instruction: string) {
  const fields = new Set<ReviewPatchableField>();
  const clauses = instruction.split(/[。．；;！？!?\r\n]+/u).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (!FIELD_REWRITE_REQUEST.test(clause)) continue;
    for (const alias of FIELD_ALIASES) {
      if (alias.pattern.test(clause)) alias.fields.forEach((field) => fields.add(field));
    }
    if (/(?:詳しく見る|詳細セクション|detail_sections)/u.test(clause)) {
      (summary.detail_sections ?? []).forEach((_section, index) => {
        fields.add(`detail_sections.${index}.heading`);
        fields.add(`detail_sections.${index}.body`);
      });
    }
  }
  return [...fields];
}

function normalizePatchOperation(raw: unknown, index: number): ReviewPatchOperation {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const field = typeof input.field === "string" ? input.field : "";
  if (!isPatchableFieldSyntax(field)) throw new ReviewRevisionContractError(`patches[${index}].field が不正です`);
  const operation = input.operation === "replace_field" ? "replace_field" : input.operation === "replace" ? "replace" : undefined;
  if (!operation) throw new ReviewRevisionContractError(`patches[${index}].operation が不正です`);
  if (typeof input.before !== "string" || typeof input.after !== "string") {
    throw new ReviewRevisionContractError(`patches[${index}] の before/after は文字列が必要です`);
  }
  return {
    field,
    operation,
    before: input.before,
    after: input.after,
    evidence_claim_refs: Array.isArray(input.evidence_claim_refs)
      ? [...new Set(input.evidence_claim_refs.filter((ref): ref is string => typeof ref === "string"))]
      : [],
    reason: typeof input.reason === "string" ? input.reason.trim() : ""
  };
}

function prepareReviewPatchEvidenceRefs(
  patches: ReviewPatchOperation[],
  intent: ReviewRevisionIntent,
  ledger: FactLedger,
  reasonTag: ReviewReasonTag | string
) {
  const knownClaims = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  return patches.map((patch) => {
    // Dropping evidence is safe only when the resulting text is exactly the
    // deterministic OWNER-provided terminology replacement and nothing else.
    if (isPureRequiredTerminologyReplacement(patch, intent, reasonTag)) {
      return { ...patch, evidence_claim_refs: [] };
    }
    const unavailable = patch.evidence_claim_refs.filter((ref) => {
      const claim = knownClaims.get(ref);
      return !claim || !isUsableReviewClaim(claim);
    });
    if (unavailable.length > 0) {
      throw new ReviewRevisionClarificationRequiredError(
        `事実を伴う修正に利用できない根拠claimが含まれています: ${patch.field} (${unavailable.join(", ")})`
      );
    }
    return { ...patch, evidence_claim_refs: [...patch.evidence_claim_refs] };
  });
}

function bindRequiredFieldRewriteBefore(
  before: SummarizedArticle,
  patches: ReviewPatchOperation[],
  intent: ReviewRevisionIntent
) {
  const requiredFieldRewrites = new Set(intent.required_field_rewrites);
  return patches.map((patch) => {
    if (patch.operation !== "replace_field" || !requiredFieldRewrites.has(patch.field)) return patch;
    // The current value is authoritative process input. Asking an LLM to echo a
    // long field byte-for-byte adds no safety; all rewrite scope and after-text
    // gates remain enforced below.
    return { ...patch, before: readPatchableField(before, patch.field) };
  });
}

function isPureRequiredTerminologyReplacement(
  patch: ReviewPatchOperation,
  intent: ReviewRevisionIntent,
  reasonTag: ReviewReasonTag | string
) {
  if (reasonTag !== "用語" || patch.operation !== "replace") return false;
  const requirements = intent.required_replacements.filter((replacement) => (
    replacement.target_fields.includes(patch.field) && patch.before.includes(replacement.before)
  ));
  if (requirements.length === 0) return false;
  let expectedAfter = patch.before;
  for (const replacement of requirements) {
    expectedAfter = expectedAfter.split(replacement.before).join(replacement.after);
  }
  return expectedAfter !== patch.before && expectedAfter === patch.after;
}

function isUsableReviewClaim(claim: FactLedger["claims"][number]) {
  return claim.type !== "unsupported";
}

function assertNewNumbersGrounded(patch: ReviewPatchOperation, ledger: FactLedger) {
  const beforeNumbers = normalizedNumberTokens(patch.before);
  const added = [...normalizedNumberTokens(patch.after)].filter((number) => !beforeNumbers.has(number));
  if (added.length === 0) return;
  const evidenceNumbers = new Set(ledger.claims
    .filter((claim) => patch.evidence_claim_refs.includes(claim.id))
    .flatMap(extractNormalizedClaimNumberTokens));
  const missing = added.filter((number) => !evidenceNumbers.has(number));
  if (missing.length > 0) {
    throw new ReviewRevisionClarificationRequiredError(`追加した数字を選択済み根拠claimで確認できません: ${missing.join(", ")}`);
  }
}

function normalizedNumberTokens(text: string) {
  return new Set(extractNumberTokens(text).map(normalizeNumberToken).filter(Boolean));
}

export function assertRequiredLiteralReplacementCoverage(
  before: SummarizedArticle,
  after: SummarizedArticle,
  intent: ReviewRevisionIntent
) {
  for (const replacement of intent.required_replacements) {
    for (const field of replacement.target_fields) {
      const originalValue = readPatchableField(before, field);
      const originalCount = countOccurrences(originalValue, replacement.before);
      const finalValue = readPatchableField(after, field);
      const finalReplacementCount = countOccurrences(finalValue, replacement.after);
      if (originalCount === 0 || finalReplacementCount < originalCount || (!replacement.after.includes(replacement.before) && finalValue.includes(replacement.before))) {
        throw new ReviewRevisionClarificationRequiredError(
          `明示置換を全件反映できませんでした: ${field} の ${replacement.before}→${replacement.after}`
        );
      }
    }
  }
}

function assertRequiredInstructionCoverage(
  before: SummarizedArticle,
  after: SummarizedArticle,
  patches: ReviewPatchOperation[],
  intent: ReviewRevisionIntent,
  ledger: FactLedger
) {
  for (const replacement of intent.required_replacements) {
    for (const field of replacement.target_fields) {
      const originalValue = readPatchableField(before, field);
      const originalCount = countOccurrences(originalValue, replacement.before);
      const relevantPatches = patches.filter((patch) => patch.field === field && patch.before.includes(replacement.before));
      const coveredCount = relevantPatches.reduce((total, patch) => total + countOccurrences(patch.before, replacement.before), 0);
      const producedCount = relevantPatches.reduce((total, patch) => total + countOccurrences(patch.after, replacement.after), 0);
      const finalValue = readPatchableField(after, field);
      const leftUnchanged = !replacement.after.includes(replacement.before) && finalValue.includes(replacement.before);
      if (originalCount === 0 || coveredCount < originalCount || producedCount < originalCount || leftUnchanged) {
        throw new ReviewRevisionClarificationRequiredError(
          `明示置換を全件反映できませんでした: ${field} の ${replacement.before}→${replacement.after}`
        );
      }
    }
  }

  assertRequiredLiteralReplacementCoverage(before, after, intent);

  const usableClaims = new Set(ledger.claims.filter(isUsableReviewClaim).map((claim) => claim.id));
  for (const field of intent.required_field_rewrites) {
    const rewritePatch = patches.find((patch) => patch.field === field && patch.operation === "replace_field");
    if (!rewritePatch) {
      throw new ReviewRevisionClarificationRequiredError(`再構成指示がフィールド全体の書き直しになっていません: ${field}`);
    }
    const usableEvidenceRefs = new Set(rewritePatch.evidence_claim_refs.filter((ref) => usableClaims.has(ref)));
    if (usableEvidenceRefs.size === 0) {
      throw new ReviewRevisionClarificationRequiredError(`根拠claimに基づく再構成を作れませんでした: ${field}`);
    }
    if (field === "why_it_matters" && usableEvidenceRefs.size < 2) {
      throw new ReviewRevisionClarificationRequiredError(`注目ポイントを関係説明へ再構成できる根拠claimが不足しています: ${field}`);
    }
    if (isSuperficialFieldRewrite(rewritePatch.before, rewritePatch.after)) {
      throw new ReviewRevisionFieldRewriteRepairableError(field, "superficial_rewrite");
    }
  }
}

function assertLedgerCanSupportFieldRewrite(field: ReviewPatchableField, ledger: FactLedger) {
  const usableClaimCount = new Set(ledger.claims.filter(isUsableReviewClaim).map((claim) => claim.id)).size;
  if (usableClaimCount === 0) {
    throw new ReviewRevisionClarificationRequiredError(`根拠claimに基づく再構成を作れませんでした: ${field}`);
  }
  if (field === "why_it_matters" && usableClaimCount < 2) {
    throw new ReviewRevisionClarificationRequiredError(`注目ポイントを関係説明へ再構成できる根拠claimが不足しています: ${field}`);
  }
}

function isSuperficialFieldRewrite(before: string, after: string) {
  const normalizedBefore = normalizeRewriteComparison(before);
  const normalizedAfter = normalizeRewriteComparison(after);
  if (!normalizedBefore || !normalizedAfter || normalizedBefore === normalizedAfter) return true;
  if (normalizedAfter.includes(normalizedBefore)) return true;
  if (normalizedBefore.length < 40) return false;
  const beforeShingles = characterShingles(normalizedBefore, 5);
  const afterShingles = characterShingles(normalizedAfter, 5);
  if (beforeShingles.size === 0) return false;
  const retained = [...beforeShingles].filter((shingle) => afterShingles.has(shingle)).length / beforeShingles.size;
  return retained >= 0.9;
}

function normalizeRewriteComparison(value: string) {
  return value.normalize("NFKC").replace(/[\s、。．,，；;：:！？!?「」『』“”"'（）()\[\]【】]/gu, "");
}

function characterShingles(value: string, size: number) {
  const shingles = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) shingles.add(value.slice(index, index + size));
  return shingles;
}

export function buildReviewRevisionTrace(
  before: SummarizedArticle,
  after: SummarizedArticle,
  patches: ReviewPatchOperation[],
  intent: ReviewRevisionIntent,
  instruction: string
): ReviewRevisionTrace {
  const changed = new Set(patches.map((patch) => patch.field));
  for (const field of listPatchableFields(before)) {
    if (!changed.has(field) && readPatchableField(before, field) !== readPatchableField(after, field)) {
      throw new ReviewRevisionContractError(`非対象フィールドが変化しました: ${field}`);
    }
  }
  if (JSON.stringify(before.source_list) !== JSON.stringify(after.source_list)) throw new ReviewRevisionContractError("source_list が変化しました");
  if (JSON.stringify(before.related_sources) !== JSON.stringify(after.related_sources)) throw new ReviewRevisionContractError("related_sources が変化しました");
  if (!changed.has("reaction_view") && before.reaction_view !== after.reaction_view) {
    throw new ReviewRevisionContractError("非対象の reaction_view が変化しました");
  }
  const explicit = new Set(intent.explicit_fields);
  for (const patch of patches) {
    if (patch.operation !== "replace_field") continue;
    if (patch.before && !SHORTENING_REQUEST.test(instruction) && patch.after.length < patch.before.length * 0.7) {
      throw new ReviewRevisionContractError(`フィールド全体の情報量が大きく減っています: ${patch.field}`);
    }
    if (!explicit.has(patch.field)) throw new ReviewRevisionContractError(`非明示フィールドの全体置換です: ${patch.field}`);
  }
  const beforeRefs = allClaimRefs(before);
  const afterRefs = allClaimRefs(after);
  const removedRefs = beforeRefs.filter((ref) => !afterRefs.includes(ref));
  if (removedRefs.length > 0) throw new ReviewRevisionContractError(`既存claim refsが失われました: ${removedRefs.join(", ")}`);
  const beforeNumbers = extractNumbers(articleNarrative(before));
  const afterNumbers = extractNumbers(articleNarrative(after));
  const removedNumbers = beforeNumbers.filter((number) => !afterNumbers.includes(number));
  const authorizedBefore = patches.map((patch) => patch.before).join("\n");
  const unauthorizedNumbers = removedNumbers.filter((number) => !authorizedBefore.includes(number) || !instruction.includes(number));
  if (unauthorizedNumbers.length > 0) {
    throw new ReviewRevisionContractError(`指示されていない重要数字が失われました: ${unauthorizedNumbers.join(", ")}`);
  }
  const beforeEntities = visibleEntities(before);
  const afterEntities = visibleEntities(after);
  const unauthorizedEntities = beforeEntities.filter((entity) => !afterEntities.includes(entity) && !instruction.includes(entity));
  if (unauthorizedEntities.length > 0) {
    throw new ReviewRevisionContractError(`指示されていない人物・作品が失われました: ${unauthorizedEntities.join(", ")}`);
  }
  return {
    mode: "limited_patch",
    changed_fields: [...changed],
    changes: patches.map((patch) => ({
      field: patch.field,
      before: patch.before,
      after: patch.after,
      evidence_claim_refs: [...patch.evidence_claim_refs],
      reason: patch.reason
    })),
    preservation: {
      untouched_fields_exact: true,
      source_list_exact: true,
      related_sources_exact: true,
      reaction_view_preserved_when_untargeted: !changed.has("reaction_view") ? before.reaction_view === after.reaction_view : true,
      claim_refs_before: beforeRefs.length,
      claim_refs_after: afterRefs.length,
      important_numbers_before: beforeNumbers,
      important_numbers_after: afterNumbers,
      entities_before: beforeEntities,
      entities_after: afterEntities,
      narrative_chars_before: articleNarrative(before).length,
      narrative_chars_after: articleNarrative(after).length
    }
  };
}

export function buildFullRewriteTrace(before: SummarizedArticle, after: SummarizedArticle): ReviewRevisionTrace {
  const changedFields = listPatchableFields(before).filter((field) => readPatchableField(before, field) !== readPatchableField(after, field));
  const beforeRefs = allClaimRefs(before);
  const afterRefs = allClaimRefs(after);
  return {
    mode: "full_rewrite",
    changed_fields: changedFields,
    changes: changedFields.map((field) => ({
      field,
      before: readPatchableField(before, field),
      after: readPatchableField(after, field),
      evidence_claim_refs: [],
      reason: "明示された全体書き直し"
    })),
    preservation: {
      untouched_fields_exact: true,
      source_list_exact: JSON.stringify(before.source_list) === JSON.stringify(after.source_list),
      related_sources_exact: JSON.stringify(before.related_sources) === JSON.stringify(after.related_sources),
      reaction_view_preserved_when_untargeted: true,
      claim_refs_before: beforeRefs.length,
      claim_refs_after: afterRefs.length,
      important_numbers_before: extractNumbers(articleNarrative(before)),
      important_numbers_after: extractNumbers(articleNarrative(after)),
      entities_before: visibleEntities(before),
      entities_after: visibleEntities(after),
      narrative_chars_before: articleNarrative(before).length,
      narrative_chars_after: articleNarrative(after).length
    }
  };
}

function assertNoNewDisplayResidues(before: SummarizedArticle, after: SummarizedArticle) {
  const beforeSet = new Set(inspectDisplayKanjiResidues(before).map((item) => `${item.field}:${item.chars.join("")}`));
  const added = inspectDisplayKanjiResidues(after).filter((item) => !beforeSet.has(`${item.field}:${item.chars.join("")}`));
  if (added.length > 0) throw new ReviewRevisionContractError(`修正で表示用漢字の残留が増えました: ${added.map((item) => item.field).join(", ")}`);
}

function assertNoNewGates(before: ClaimCheckResult, after: ClaimCheckResult, label: string) {
  const beforeKeys = new Set(before.violations.filter((item) => item.severity === "gate").map(gateKey));
  const added = after.violations.filter((item) => item.severity === "gate" && !beforeKeys.has(gateKey(item)));
  if (added.length > 0) throw new ReviewRevisionContractError(`${label}で新しいgateが発生しました: ${added.map((item) => item.rule).join(", ")}`);
}

function gateKey(item: { section: string; rule: string; detail: string; number_token?: string }) {
  return item.number_token ? `${item.section}:${item.rule}:${item.number_token}` : `${item.section}:${item.rule}`;
}

function addPatchClaimRefs(summary: SummarizedArticle, field: ReviewPatchableField, refs: string[]) {
  if (refs.length === 0) return summary;
  const next = structuredClone(summary);
  if (field.startsWith("detail_sections.")) {
    const index = Number(field.split(".")[1]);
    const section = next.detail_sections?.[index];
    if (!section) throw new ReviewRevisionContractError(`detail section がありません: ${field}`);
    section.claim_refs = stableUnion(section.claim_refs, refs);
    return next;
  }
  const claimField = field === "reaction_view"
    ? "reaction_view"
    : field === "why_it_matters"
      ? "why_it_matters"
      : field === "japan_context_note"
        ? "japan_context_note"
        : "what_happened";
  next.claim_refs[claimField] = stableUnion(next.claim_refs[claimField], refs);
  return next;
}

function listPatchableFields(summary: SummarizedArticle): ReviewPatchableField[] {
  const detailFields = (summary.detail_sections ?? []).flatMap((_section, index) => [
    `detail_sections.${index}.heading`,
    `detail_sections.${index}.body`
  ] as ReviewPatchableField[]);
  return [...TOP_LEVEL_FIELDS, ...detailFields];
}

function readPatchableField(summary: SummarizedArticle, field: ReviewPatchableField) {
  if (isTopLevelField(field)) return summary[field];
  const [, indexText, property] = field.split(".");
  const section = summary.detail_sections?.[Number(indexText)];
  if (!section || (property !== "heading" && property !== "body")) throw new ReviewRevisionContractError(`フィールドが存在しません: ${field}`);
  return section[property];
}

function writePatchableField(summary: SummarizedArticle, field: ReviewPatchableField, value: string) {
  const next = structuredClone(summary);
  if (isTopLevelField(field)) {
    next[field] = value;
    return next;
  }
  const [, indexText, property] = field.split(".");
  const section = next.detail_sections?.[Number(indexText)];
  if (!section || (property !== "heading" && property !== "body")) throw new ReviewRevisionContractError(`フィールドが存在しません: ${field}`);
  section[property] = value;
  return next;
}

function isPatchableFieldSyntax(field: string): field is ReviewPatchableField {
  return TOP_LEVEL_FIELDS.includes(field as (typeof TOP_LEVEL_FIELDS)[number]) || /^detail_sections\.\d+\.(?:heading|body)$/.test(field);
}

function isTopLevelField(field: ReviewPatchableField): field is (typeof TOP_LEVEL_FIELDS)[number] {
  return TOP_LEVEL_FIELDS.includes(field as (typeof TOP_LEVEL_FIELDS)[number]);
}

function countOccurrences(text: string, needle: string) {
  let count = 0;
  let position = 0;
  while (needle && (position = text.indexOf(needle, position)) >= 0) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function extractNumbers(text: string) {
  return [...new Set(text.match(/\d+(?:[.,]\d+)?(?:億|亿|万)?(?:円|元|人|本|件|回|日|月|年|点|%|％)?/gu) ?? [])];
}

function visibleEntities(summary: SummarizedArticle) {
  const text = articleNarrative(summary);
  return [...new Set([
    ...summary.main_entities.people,
    ...summary.main_entities.works,
    ...summary.main_entities.organizations
  ].filter((entity) => entity && text.includes(entity)))];
}

function articleNarrative(summary: SummarizedArticle) {
  return [
    summary.title_ja,
    summary.lead,
    summary.what_happened,
    summary.reaction_view,
    summary.why_it_matters,
    summary.japan_context_note,
    ...(summary.detail_sections ?? []).flatMap((section) => [section.heading, section.body])
  ].join("\n");
}

function articleBodyText(summary: SummarizedArticle) {
  return [summary.lead, summary.what_happened, ...(summary.detail_sections ?? []).map((section) => section.body)].join("\n");
}

function articleBodyClaimRefs(summary: SummarizedArticle) {
  return [...new Set([
    ...(summary.claim_refs.what_happened ?? []),
    ...(summary.detail_sections ?? []).flatMap((section) => section.claim_refs ?? [])
  ])];
}

function allClaimRefs(summary: SummarizedArticle) {
  return [...new Set([
    ...summary.claim_refs.what_happened,
    ...summary.claim_refs.why_it_matters,
    ...summary.claim_refs.reaction_view,
    ...summary.claim_refs.japan_context_note,
    ...(summary.detail_sections ?? []).flatMap((section) => section.claim_refs)
  ])];
}

function stableUnion(current: string[], added: string[]) {
  return [...current, ...added.filter((ref) => !current.includes(ref))];
}
