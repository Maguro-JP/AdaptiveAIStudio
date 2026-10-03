/**
 * テストのファイルの見分け方と、テストと skip の数え方。
 *
 * 書く前に止める規則（`harness/builtin-rules.ts` の testProtection）と、作業の前後で比べる
 * `test-integrity.ts` が同じ表を見る。二つに持っていると、片方だけ直って食い違う。
 */

/**
 * テストのファイル。言語ごとの既定の名前とフォルダを見る。
 * jest の `__tests__/` と pytest の `*_test.py` も既定の形（見ていなかったので、そこのテストを消しても止まらなかった）。
 */
const TEST_FILE = /(\.|_|^)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|_test\.go$|(^|\/)tests?\/|(^|\/)__tests__\//i;

export function isTestFile(path: string): boolean {
  // `tests\test_api.py` のような `\` 区切りの道も見る（`/` だけを見ていたので、テストを守る規則を素通りした）
  return TEST_FILE.test(path.replace(/\\/g, '/'));
}

/** テスト定義の数え方。言語ごとの代表的な書き方だけを見る。 */
const CASE_PATTERNS = [
  /\b(?:test|it)\s*(?:\.\w+)?\s*\(/g,   // JS/TS: test(...) it(...)
  /^\s*def\s+test_\w+/gm,                // Python
  /\bfunc\s+Test\w+\s*\(/g,              // Go
  /^\s*#\[test\]/gm,                     // Rust
];

/**
 * skip・無効化の痕跡。数と別に見る。
 *
 * node:test の `test('a', { skip: true }, …)` は、test() の二つ目の引数の頭にある選択肢だけを見る
 * （テストの中の `find({ skip: 10 })` のような、ただの値まで数えないため）。
 * `xit(` などはメソッド呼び出しを外す（`model.fit(` や `fitAddon.fit()` に当てない）。
 */
const SKIP_PATTERNS = [
  /\b(?:test|it|describe)\s*\.\s*(?:skip|todo)\s*\(/g,
  /(?<![.\w$])(?:xit|xtest|xdescribe)\s*\(/g,
  /\b(?:test|it|describe|suite)\s*\(\s*(['"`])(?:(?!\1)[^\n])*\1\s*,\s*\{[^{}\n]*?\b(?:skip|todo)\s*:/g,
  /(?<![.\w$])t\.skip\s*\(/g,        // node:test の中から
  /@(?:pytest\.mark\.|unittest\.)?skip/g,
  /\bt\.Skip(?:f|Now)?\s*\(/g,           // Go
  /^\s*#\[ignore\b/gm,                   // Rust
];

/** 絞り込みの痕跡。一つ足すだけで他のテストが全部走らなくなるので、skip とは別に、増やすこと自体を止める。 */
const FOCUS_PATTERNS = [
  /\b(?:test|it|describe)\s*\.\s*only\s*\(/g,
  /(?<![.\w$])(?:fit|fdescribe)\s*\(/g,
  /\b(?:test|it|describe|suite)\s*\(\s*(['"`])(?:(?!\1)[^\n])*\1\s*,\s*\{[^{}\n]*?\bonly\s*:/g,
];

export function countCases(text: string): number {
  let n = 0;
  for (const p of CASE_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

export function countSkips(text: string): number {
  let n = 0;
  for (const p of SKIP_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

export function countFocus(text: string): number {
  let n = 0;
  for (const p of FOCUS_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}
