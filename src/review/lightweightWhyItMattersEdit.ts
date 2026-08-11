export type LightweightWhyItMattersEdit = { literal: string };

export type LightweightWhyItMattersEditResult =
  | { ok: true; value: string; edit: LightweightWhyItMattersEdit }
  | { ok: false; reason: "not_literal_instruction" | "empty_source" | "literal_not_unique" | "empty_result" };

/**
 * Accept only a complete, quoted literal deletion instruction. Anything with
 * extra prose (including another-field requests) deliberately falls through
 * to the normal LLM review route.
 */
export function parseLightweightWhyItMattersEdit(comment: string): LightweightWhyItMattersEdit | null {
  let instruction = comment.trim();
  instruction = instruction.replace(/^(?:(?:?????)???????(?:?)?(?:?)?\s*)/u, "");
  instruction = instruction.replace(/(?:??\s*????(?:???)??????????????)$/u, "").trim();
  const deletionMatch = instruction.match(/^?([^??\r\n]+)?\s*(?:??\s*)?(?:?\s*)?(?:??|??)(?:??????|??)???$/u);
  return deletionMatch ? { literal: deletionMatch[1] } : null;
}

export function applyLightweightWhyItMattersEdit(
  whyItMatters: string,
  comment: string
): LightweightWhyItMattersEditResult {
  const edit = parseLightweightWhyItMattersEdit(comment);
  if (!edit) return { ok: false, reason: "not_literal_instruction" };
  if (!whyItMatters.trim()) return { ok: false, reason: "empty_source" };

  if (countOccurrences(whyItMatters, edit.literal) !== 1) return { ok: false, reason: "literal_not_unique" };

  const value = whyItMatters.replace(edit.literal, "");
  if (!value.trim()) return { ok: false, reason: "empty_result" };
  return { ok: true, value, edit };
}

function countOccurrences(value: string, literal: string) {
  let count = 0;
  let position = 0;
  while (position <= value.length - literal.length) {
    const found = value.indexOf(literal, position);
    if (found < 0) break;
    count += 1;
    position = found + 1;
  }
  return count;
}
