/**
 * 提案を足す所は、どれもどの作業場の提案かを付ける（DECISIONS 10-11、111 回目）。
 *
 * 端末のパネルの経路だけ付けずにいたので、作業場の無い提案になり、どの作業場の一覧にも出て、別の作業場で採用・実行されえた。
 * 経路が増えても抜けないよう、`proposals.add({ … })` の呼び出しを全部見る（振る舞いは端末を動かさずには確かめられない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('proposals.add の呼び出しは、どれも root を渡す', () => {
  const missing: string[] = [];
  let seen = 0;
  for (const file of sources(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const m of text.matchAll(/proposals\.add\(\{([\s\S]*?)\n\s*\}\);/g)) {
      seen += 1;
      if (!/\broot:/.test(m[1]!)) missing.push(`${relative(root, file)}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(seen >= 1, `呼び出しを見つけられていない（この試験の前提が崩れた）: ${seen}`);
  assert.deepEqual(missing, [], '作業場を付けずに提案を足している');
});
