/** Convert implementation/safety details into an actionable editor-facing reply. */
export function humanRevisionFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/修正対象.*(?:特定|判別)|変更する箇所.*(?:特定|判別)|対象のフィールド.*(?:特定|判別)/u.test(detail)) {
    return "変更する箇所を一つに特定できませんでした。";
  }
  if (/修正元|完全一致|記事内に見つかりません/u.test(detail)) return "指定された修正前の文言が記事内に見つかりません。";
  if (/根拠|claim|台帳|ledger|number|数字/u.test(detail)) return "追加内容を根拠記事で確認できませんでした。";
  if (/許可されていないフィールド|範囲を超えて|非対象フィールド|非明示フィールド|フィールド全体の置換|検出済みアンカーを含まない変更/u.test(detail)) {
    return "修正案が指定された範囲外まで変更しようとしたため、元の記事は変更していません。";
  }
  return "修正案を作れませんでした。元の記事は変更していません。";
}
