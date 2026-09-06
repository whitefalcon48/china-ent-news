type PatchableText<Field extends string> = {
  field: Field;
  value: string;
};

export type InferredInstructionAnchor<Field extends string> = {
  field: Field;
  anchor: string;
};

const EDITING_LANGUAGE = /(?:削除|消(?:して|す|し)|取り除|外(?:して|す|し)|不要|いらない|要らない|分かりやす|わかりやす|理解しやす|説明|整理|直(?:して|す|し)|修正|変更|置換|短く|省略)/u;
const PRESERVATION_LANGUAGE = /(?:保持|維持|残(?:して|す|し)|(?:変更|修正)(?:は)?(?:しない|しません|せず|しなくて(?:いい|よい)|する必要はない|不要)|変え(?:ない|ず)|そのまま(?:にする)?|触らない|いじらない|不要ではない|(?:削除|消去)(?:は)?(?:しない|しません|せず|しなくて(?:いい|よい)|する必要はない|不要)|(?:削ら|消さ|取り除か|外さ)(?:ない|ず)|説明(?:は)?不要)/u;
const QUOTED_LITERAL = /[「」『』“”"]/u;
const MAX_INSTRUCTION_CHARS = 4_000;
const MAX_FIELD_CHARS = 20_000;
const MAX_COMPARISON_CELLS = 4_000_000;

/**
 * Infer one safe, unquoted anchor from natural-language editing feedback.
 * This deliberately has no punctuation-normalization path: punctuation-only
 * differences must not join two otherwise separate snippets.
 */
export function inferUnquotedInstructionAnchor<Field extends string>(
  fields: readonly PatchableText<Field>[],
  instruction: string
): InferredInstructionAnchor<Field> | null {
  // This is a fallback only. Refuse expensive inference rather than delaying
  // or weakening the established explicit anchor routes.
  if (instruction.length > MAX_INSTRUCTION_CHARS || fields.some(({ value }) => value.length > MAX_FIELD_CHARS)) return null;
  const sentences = splitInstructionSentences(instruction)
    .filter((sentence) => EDITING_LANGUAGE.test(sentence))
    .filter((sentence) => !PRESERVATION_LANGUAGE.test(sentence))
    .filter((sentence) => !QUOTED_LITERAL.test(sentence));
  // Searching only some fields could make a multi-location instruction look
  // unique. Bound the complete inference operation before collecting spans.
  const comparisonCells = sentences.reduce((total, sentence) => (
    total + fields.reduce((fieldTotal, { value }) => fieldTotal + value.length * sentence.length, 0)
  ), 0);
  if (comparisonCells > MAX_COMPARISON_CELLS) return null;
  const candidates = sentences
    .flatMap((sentence) => fields.flatMap(({ field, value }) => (
      unextendableCommonSpans(value, sentence)
        .filter(isSafeLiteral)
        .map((anchor) => ({ field, anchor }))
    )));

  const maximal = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) => (
    otherIndex !== index
    && other.anchor.length > candidate.anchor.length
    && other.anchor.includes(candidate.anchor)
  )));
  const distinctAnchors = [...new Set(maximal.map((candidate) => candidate.anchor))];
  // More than one independent literal is not a safely inferred destination.
  if (distinctAnchors.length !== 1) return null;

  const anchor = distinctAnchors[0];
  const locations = fields.flatMap(({ field, value }) => (
    Array.from({ length: countOccurrences(value, anchor) }, () => ({ field, anchor }))
  ));
  return locations.length === 1 ? locations[0] : null;
}

function splitInstructionSentences(instruction: string) {
  return instruction.split(/[。．；;！？!?\r\n]+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

function unextendableCommonSpans(left: string, right: string) {
  if (!left || !right) return [];
  let previous = new Array<number>(right.length + 1).fill(0);
  const spans = new Set<string>();
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      const length = previous[rightIndex - 1] + 1;
      current[rightIndex] = length;
      // `length` already includes every matching character to the left. Take
      // it only where neither string can extend the match to the right.
      const canExtendRight = leftIndex < left.length
        && rightIndex < right.length
        && left[leftIndex] === right[rightIndex];
      if (!canExtendRight && length >= 8) spans.add(left.slice(leftIndex - length, leftIndex));
    }
    previous = current;
  }
  return [...spans];
}

function isSafeLiteral(value: string) {
  const hanCount = (value.match(/\p{Script=Han}/gu) ?? []).length;
  return value.length >= 8 && hanCount >= 2;
}

function countOccurrences(value: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (needle && (offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}
