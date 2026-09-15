/**
 * 道具の呼び方を、**文章で**教える。
 *
 * node-llama-cpp は、モデルに合う「型」（chat wrapper）が分かるときだけ
 * 道具を渡せる。分からないときは当てずっぽうの型（General など）になり、
 * そこへ道具を渡しても**モデルには何も届かない**。届かないので何も呼ばず、
 * 画面には「動いているが何もしない」だけが残る。**いちばん質が悪い壊れ方。**
 *
 * ここでは、型に頼らず本文で道具を渡す。返し方も決めた形に固定して、
 * `src/agent/tool-text.ts` で拾う（同じ印を使う）。
 *
 * 印は ASCII で固定する。日本語にすると、モデルが語形を変えて出す。
 */

export interface ToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

/** 引数の形を、短い一行にする。丸ごとの JSON Schema は長すぎて窓を食う。 */
export function paramLine(parameters: unknown): string {
  const p = parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined;
  const props = p?.properties;
  if (!props) return '{}';
  const need = new Set(p?.required ?? []);
  const parts = Object.entries(props).map(([k, v]) => {
    const type = typeof v?.type === 'string' ? v.type : 'string';
    return `"${k}": ${type}${need.has(k) ? '' : '?'}`;
  });
  return `{ ${parts.join(', ')} }`;
}

/**
 * 本文に載せる、道具の説明。
 *
 * 例（そのまま真似させる）を必ず入れる。形だけ言っても、小さいモデルは
 * 自分の流儀で書く。
 */
export function toolPrompt(tools: readonly ToolSpec[]): string {
  if (tools.length === 0) return '';
  const lines = [
    '使える道具があります。使うときは、次の形だけで書いてください。',
    '',
    '<tool_call>{"name": "道具の名前", "arguments": { ... }}</tool_call>',
    '',
    '一度に一つ。前置きも説明も要りません。結果はこちらから渡します。',
    '',
    '道具:',
  ];
  for (const t of tools) {
    const desc = t.description ? ` — ${t.description}` : '';
    lines.push(`- ${t.name}${desc}`);
    lines.push(`  引数: ${paramLine(t.parameters)}`);
  }
  return lines.join('\n');
}
