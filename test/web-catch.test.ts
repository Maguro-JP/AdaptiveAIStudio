/**
 * 画面から出す呼び出しに、**受け手を置く。**
 *
 * `await fetch(...)` は、繋がらなければ例外になる。受け手が無いと、落ちるのは
 * 呼び出しの外（`void f()` や `onclick`）なので、**画面には何も出ない。**
 * 押したのに何も起きない、送ったのに何も返らない、設定が空欄のまま——
 * 見え方は違うが、元は同じ形。同じ壊れ方を何度も出した。
 *
 * 一つずつ直しても、次に書いたところでまた同じ形になる。**数を上限にして、
 * 増やせないようにする。**減らすのは自由。増やすと、ここで止まる。
 *
 * `src/ui/web/app.js` は最後の網（`showCrash`）も持っているが、それは
 * 「何かが止まった」としか言えない。何が起きたかを言えるのは、その場の受け手だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// **走らせる場所で結果が変わらないように、根から辿る。**
const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'web');

/** いま受け手が無いもの。**この数を超えない。** */
const CEILING = 27;

function unguarded(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(web).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(web, file), 'utf8');
    for (const m of src.matchAll(/await fetch\(/g)) {
      const at = m.index ?? 0;
      const stmt = src.slice(at, src.indexOf(';', at) + 1);
      const before = src.slice(Math.max(0, at - 400), at);
      // その場に `.catch(` があるか、`try {` の中にいるか。
      if (stmt.includes('.catch(') || /try\s*\{[^}]*$/.test(before)) continue;
      found.push(`${file}:${src.slice(0, at).split('\n').length}`);
    }
  }
  return found;
}

test('受け手の無い呼び出しを増やさない', () => {
  const now = unguarded();
  assert.ok(now.length <= CEILING,
    `受け手（.catch か try）の無い fetch が増えています（${now.length} > ${CEILING}）:\n`
    + `  ${now.join('\n  ')}`);
});

test('画面には、拾い手のいない例外を受ける最後の網がある', () => {
  // 受け手を書き忘れても、利用者には何か出る。console だけに出しても見えない。
  const app = readFileSync(join(web, 'app.js'), 'utf8');
  assert.ok(app.includes("addEventListener('unhandledrejection'"), '最後の網がありません');
  assert.ok(/function showCrash[\s\S]{0,600}document\.body\.append/.test(app),
    '受けているが、画面に出していません');
});
