/** Convert implementation/safety details into an actionable editor-facing reply. */
export function humanRevisionFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/修正元|完全一致|記事内に見つかりません/u.test(detail)) return "指定された修正前の文言が記事内に見つかりません。";
  if (/根拠|claim|台帳|ledger|number|数字/u.test(detail)) return "追加内容を根拠記事で確認できませんでした。";
  if (/対象|フィールド|field|限定/u.test(detail)) return "変更する箇所を一つに特定できませんでした。";
  return "修正案を作れませんでした。元の記事は変更していません。";
}
