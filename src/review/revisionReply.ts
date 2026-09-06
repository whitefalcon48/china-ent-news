/** Convert implementation/safety details into an actionable editor-facing reply. */
export function humanRevisionFailure(error: unknown, instruction = "") {
  const detail = error instanceof Error ? error.message : String(error);
  if (/追加出典を含む記事の全文書き直し/u.test(detail)) {
    return "追加出典を含む記事は、全文書き直しにはまだ対応していません。変更する欄を指定した限定修正を利用してください。";
  }
  if (/根拠|claim|台帳|ledger|number|数字/u.test(detail)) {
    const term = explanationTerm(instruction);
    const deletionOnly = /(?:削除|消(?:して|す|し)|取り除|外(?:して|す|し)|いらない|要らない)/u.test(instruction);
    const base = term
      ? `「${term}」の説明を裏付ける根拠資料の追加確認が必要です。この修正操作では、新しい資料URLを送るだけでは反映されません。`
      : "追加内容を裏付ける根拠資料の追加確認が必要です。";
    return deletionOnly ? `${base}今の資料で進めるなら、説明の追加を外し、削除する文を示した指示を送ってください。` : base;
  }
  if (/修正対象.*(?:特定|判別)|変更する箇所.*(?:特定|判別)|対象のフィールド.*(?:特定|判別)/u.test(detail)) {
    return "変更する箇所を一つに特定できませんでした。直したい文の一部か、記事の欄名を教えてください。例：何が起きたかの2文目を短く。";
  }
  if (/修正元|完全一致|記事内に見つかりません/u.test(detail)) return "指定された修正前の文言が記事内に見つかりません。";
  if (/許可されていないフィールド|範囲を超えて|非対象フィールド|非明示フィールド|フィールド全体の置換|検出済みアンカーを含まない変更/u.test(detail)) {
    return "修正案が指定された範囲外まで変更しようとしたため、元の記事は変更していません。";
  }
  return "修正案を作れませんでした。元の記事は変更していません。";
}

/** Extract only a small, plain-text term from a request such as「国家安全部とはなにか」. */
function explanationTerm(instruction: string) {
  const match = instruction.match(/(?:「([^」]+)」|([^\s、。！？!?]{1,40}))とは(?:何|なに)(?:か)?/u);
  const term = (match?.[1] || match?.[2] || "").trim();
  if (!term || term.length > 40) return "";
  // Do not reflect links, Markdown, or control characters into an Issue reply.
  if (/[\u0000-\u001f\u007f\[\]()`*_#<>@\\]|https?:\/\//iu.test(term)) return "";
  return term;
}
