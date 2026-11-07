/**
 * 問いの中の四則の式を、この機械で正しく計算する。
 *
 * 4B のモデルは 1234 × 5678 を 7001052 と答えた（check-work、docs/knowledge/work-check-2026-11-08.md）。
 * 計算はモデルに任せず、値を system に載せて使わせる。式は数と + - × * ÷ / と括弧だけを読み、eval は使わない。
 */

/** 式に見える所（数と演算子が 1 つ以上）。 */
const EXPR = /[(（]*\s*-?\d[\d,.]*(?:\s*[)）]*\s*[+\-−×xX*＊÷/／]\s*[(（]*\s*-?\d[\d,.]*\s*[)）]*)+/g;

type Tok = { t: 'n'; v: number } | { t: 'o'; v: string };

function tokens(src: string): Tok[] | undefined {
  const s = src.normalize('NFKC').replace(/[−]/g, '-').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/(\d),(?=\d{3})/g, '$1');
  const out: Tok[] = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?|[+\-*/()]|\S/g)) {
    const x = m[0];
    if (/^\d/.test(x)) out.push({ t: 'n', v: Number(x) });
    else if ('+-*/()'.includes(x)) out.push({ t: 'o', v: x });
    else return undefined;
  }
  return out;
}

/** 字句の並びを計算する（掛け算・割り算が先）。形が違えば undefined。 */
function evaluate(toks: Tok[]): number | undefined {
  let i = 0;
  const peek = () => toks[i];
  const factor = (): number | undefined => {
    const k = toks[i++];
    if (!k) return undefined;
    if (k.t === 'n') return k.v;
    if (k.v === '-') { const v = factor(); return v === undefined ? undefined : -v; }
    if (k.v === '(') { const v = expr(); if (peek()?.v !== ')') return undefined; i += 1; return v; }
    return undefined;
  };
  const term = (): number | undefined => {
    let v = factor();
    while (v !== undefined && (peek()?.v === '*' || peek()?.v === '/')) {
      const op = toks[i++]!.v;
      const r = factor();
      if (r === undefined || (op === '/' && r === 0)) return undefined;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | undefined => {
    let v = term();
    while (v !== undefined && (peek()?.v === '+' || peek()?.v === '-')) {
      const op = toks[i++]!.v;
      const r = term();
      if (r === undefined) return undefined;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  return i === toks.length && v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** 問いの中の式と、その値。式が無ければ空。 */
export function arithmeticIn(text: string): { expr: string; value: string }[] {
  const out: { expr: string; value: string }[] = [];
  for (const m of String(text ?? '').matchAll(EXPR)) {
    const expr = m[0].trim();
    // 日付（2026-11-08）や電話番号のような - だけのつながりは式と読まない
    if (/^\d+(?:-\d+)+$/.test(expr)) continue;
    const toks = tokens(expr);
    if (!toks) continue;
    const v = evaluate(toks);
    if (v === undefined) continue;
    const value = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
    out.push({ expr, value });
  }
  return out.slice(0, 5);
}

/** system に足す塊。式が無ければ空の文字列。 */
export function arithmeticBlock(text: string): string {
  const got = arithmeticIn(text);
  if (got.length === 0) return '';
  return ['## 計算（この機械で計算した正しい値。計算し直さず、この値で答える）', ...got.map((g) => `- ${g.expr} = ${g.value}`)].join('\n');
}
