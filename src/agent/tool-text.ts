/**
 * 文章に紛れたツール呼び出しを拾う。
 *
 * 小さいモデル（1B級）は、ツールを呼ぶ作法を守れないことがある。
 * 呼び出しの枠に入れず、本文へそのまま書いてしまう。
 *
 *   <tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
 *   ```json
 *   {"name": "read_file", "arguments": {"path": "a.ts"}}
 *   ```
 *
 * このとき二重に困る。
 *   1. 生の JSON が画面に出る（読む人には意味がない）
 *   2. 道具が動かない（呼んだつもりで、何も起きない)
 *
 * ここで拾って、本物の呼び出しへ直す。
 * 作法を守れないモデルを切り捨てるのではなく、こちらが合わせる。
 * 「モデルを自由に交換できる」は、行儀の悪いモデルも含めての話。
 */

export interface SalvagedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Salvage {
  /** 人に見せてよい部分。呼び出しの記述は取り除かれている。 */
  text: string;
  calls: SalvagedCall[];
}

/**
 * 呼び出しらしき記述の始まり。ここから先は、確かめるまで表に出さない。
 *
 * ただの ``` は含めない。含めると普通のコード片まで止めてしまい、
 * 流れて出てくる良さが失われる。中身が JSON なら `{"` の方で捕まる。
 */
const OPENER = /<tool[_▁]call>|```json|```tool_call|<\|tool_calls_begin\|>|\{\s*"/;

/** 切れ端の末尾が、始まりの途中かどうかを見るための文字列。 */
const OPENER_LITERALS = [
  '<think>',
  '<tool_call>', '<tool▁call>', '```json', '```tool_call', '<|tool_calls_begin|>',
] as const;

/** 名前として認めるもの。何でも通すと、ただの JSON を呼び出しと誤認する。 */
const NAME = /^[a-z][a-z0-9_]{1,40}$/i;

/** 引数の入れ物として使われる呼び名。モデルによって違う。 */
const ARG_KEYS = ['arguments', 'args', 'parameters', 'input'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON らしき塊を呼び出しとして読む。読めなければ undefined。 */
export function toCall(value: unknown): SalvagedCall | undefined {
  if (!isRecord(value)) return undefined;
  // OpenAI の形のまま書いたもの（`{"type":"function","function":{"name":…,"arguments":"…"}}`）は、中の `function` を読む
  if (isRecord(value.function)) return toCall(value.function);

  const name = value.name ?? value.tool ?? value.tool_name ?? value.function;
  if (typeof name !== 'string' || !NAME.test(name)) return undefined;

  for (const key of ARG_KEYS) {
    const raw = value[key];
    // 引数を文字列で二重に包んでくるモデルがある。
    const parsed = typeof raw === 'string' ? tryParse(raw) : raw;
    if (isRecord(parsed)) return { name, args: parsed };
  }
  // 引数の入れ物が無い場合、name 以外の項目を引数とみなす。
  const rest = Object.fromEntries(
    Object.entries(value).filter(([k]) => !['name', 'tool', 'tool_name', 'function', 'type'].includes(k)),
  );
  return { name, args: rest };
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { /* 崩れている。下で直してみる */ }
  try { return JSON.parse(repairControlChars(s)); } catch { return undefined; }
}

/**
 * 文字列の中に生の改行やタブを書いてしまった JSON を直す。
 *
 * 小さいモデルは、書き込む内容を素直に改行して入れてくる。
 * JSON としては壊れているが、言いたいことは明らかなので、
 * こちらで逃がし記号に直してから読む。厳しさより通ることを採る。
 */
export function repairControlChars(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === '\\') { escaped = true; out += ch; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * 先頭が `{` の位置から、対応する `}` までを切り出す。
 * 文字列の中の括弧に釣られないよう、引用符と逃がし記号を見る。
 */
export function sliceJsonObject(text: string, from: number): string | undefined {
  if (text[from] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return undefined; // 閉じていない = まだ途中
}

/**
 * 本文からツール呼び出しを抜き出す。
 * 抜き出せた分だけを本文から取り除き、残りは人に見せる。
 */
export function extractToolCalls(text: string, known?: (name: string) => boolean): Salvage {
  /*
   * **考えの中は呼び出しではない。**`<think>` の中で「例えば … と書ける」と書いた形を本物の呼び出しとして拾い、実行に回していた。
   * 考えの部分（閉じないまま終わったものは終わりまで）は、呼び出しを探す前に外し、本文にも残さない
   */
  const thinking = /<think>[\s\S]*?(?:<\/think>|$)/g;
  if (thinking.test(text)) {
    const inner = extractToolCalls(text.replace(thinking, ''), known);
    return { text: inner.calls.length > 0 ? inner.text : text.replace(thinking, '').trim(), calls: inner.calls };
  }
  const calls: SalvagedCall[] = [];
  let out = '';
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) { out += text.slice(i); break; }

    const json = sliceJsonObject(text, start);
    const parsed = json ? toCall(tryParse(json)) : undefined;
    // ツールに無い名前は呼び出しと見ない（`{"name":"demo","version":"1.0.0"}` のような答えの中の JSON を、呼び出しとして拾って消していた）
    const call = parsed && (!known || known(parsed.name)) ? parsed : undefined;
    if (!json || !call) {
      out += text.slice(i, start + 1);
      i = start + 1;
      continue;
    }

    calls.push(call);
    // 呼び出しより前の本文は残す。飾り（<tool_call> や ```json）だけを落とす。
    out = stripWrapperBefore(out + text.slice(i, start));
    i = skipWrapperAfter(text, start + json.length);
  }

  return { text: calls.length > 0 ? tidy(out) : text, calls };
}

const BEFORE = /(?:<tool[_▁]call>|```(?:json|tool_call)?|<\|tool_calls_begin\|>)\s*$/;
const AFTER = /^\s*(?:<\/tool[_▁]call>|```|<\|tool_calls_end\|>)/;

function stripWrapperBefore(s: string): string {
  return s.replace(BEFORE, '');
}

function skipWrapperAfter(text: string, from: number): number {
  const m = AFTER.exec(text.slice(from));
  return from + (m ? m[0].length : 0);
}

/** 呼び出しを抜いた跡の、余った空白と空行を整える。 */
function tidy(s: string): string {
  // 配列で並べた呼び出しを抜いた跡（`[,]`）も落とす
  const t = s.replace(/\[\s*(?:,\s*)+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t === '[]' ? '' : t;
}

/**
 * 流れてくる本文の関所。
 *
 * 呼び出しらしき記述が始まったら、そこから先は溜めておく。
 * 途中まで出してしまうと、画面に生の JSON の断片が残る。
 */
export class ToolTextFilter {
  #held = '';
  #holding = false;
  /** 考えの中（`<think>` の後、`</think>` の前）。中は表に出さず、呼び出しも探さない */
  #thinking: string | undefined;

  /** いま表に出してよい分を返す。 */
  push(delta: string): string {
    if (this.#thinking !== undefined) {
      this.#thinking += delta;
      const close = this.#thinking.indexOf('</think>');
      if (close < 0) return '';
      const rest = this.#thinking.slice(close + '</think>'.length);
      this.#thinking = undefined;
      return this.push(rest);
    }
    if (this.#holding) { this.#held += delta; return ''; }

    const combined = this.#held + delta;
    const at = firstOpener(combined);
    // 考えが呼び出しより先に始まったら、そこから先は考えとして溜めて捨てる（考えの中の呼び出しの形を拾っていた）
    const think = combined.indexOf('<think>');
    if (think >= 0 && (at < 0 || think < at)) {
      this.#held = '';
      this.#thinking = '';
      return combined.slice(0, think) + this.push(combined.slice(think + '<think>'.length));
    }
    if (at < 0) {
      // 記述の始まりが、次の切れ端にまたがっているかもしれない。
      const keep = danglingPrefixLength(combined);
      this.#held = keep > 0 ? combined.slice(combined.length - keep) : '';
      return combined.slice(0, combined.length - keep);
    }

    this.#holding = true;
    this.#held = combined.slice(at);
    return combined.slice(0, at);
  }

  /** 終わり。溜めた分から呼び出しを拾い、残った本文を返す。`known` を渡すと、ツールに在る名前だけを拾う。 */
  end(known?: (name: string) => boolean): Salvage {
    const held = this.#held;
    this.#held = '';
    this.#holding = false;
    // 閉じないまま終わった考えは、捨てる
    this.#thinking = undefined;
    if (held === '') return { text: '', calls: [] };
    return extractToolCalls(held, known);
  }

  /** 溜めている分をそのまま吐き出す。拾わずに見せると決めたとき用。 */
  drain(): string {
    const held = this.#held;
    this.#held = '';
    this.#holding = false;
    return held;
  }
}

function firstOpener(s: string): number {
  return s.search(OPENER);
}

/** 末尾が、記述の始まりの途中かもしれない長さ。 */
function danglingPrefixLength(s: string): number {
  // `{` のあとに空白だけ、あるいは `{ "` の手前まで来ている場合。
  const brace = /\{\s*$/.exec(s);
  if (brace) return brace[0].length;

  const max = Math.max(...OPENER_LITERALS.map((o) => o.length)) - 1;
  for (let len = Math.min(max, s.length); len > 0; len -= 1) {
    const tail = s.slice(s.length - len);
    if (OPENER_LITERALS.some((o) => o.startsWith(tail))) return len;
  }
  return 0;
}
