/**
 * 待たずに走らせるものに、受け手を置く。
 *
 * `void something()` は返事を待たないという書き方だが、**そこで例外が出たときの
 * 受け手も居ない。**Node は拾い手のない例外でプロセスごと落とすので、
 * 書き込みが一度失敗しただけで画面が消える。
 *
 * 画面の口（`UiServer` の `createServer`）は受けていたが、待たずに走らせる
 * 側（`#drive`・見回り・順番待ち・プレビュー・モデルの口）は受けていなかった。
 *
 * ここは走らせて出す種類のものではないので、書き方で止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('待たずに走らせるものに、受け手がある', () => {
  const bad: string[] = [];
  for (const file of tsFiles('src')) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // `void 何か(` で始まる呼び出しだけを見る。値を捨てるだけの `void 0` は違う。
      if (!/(^|[^.\w])void\s+[\w#.[\]]+\(/.test(line)) return;
      // 受け手は、同じ行か、続く数行に付く（`.then(...).catch(...)`）。
      const near = lines.slice(i, i + 12).join('\n');
      if (near.includes('.catch(')) return;
      bad.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], `拾い手が居ません。落ちるとプロセスごと消えます:\n  ${bad.join('\n  ')}`);
});
