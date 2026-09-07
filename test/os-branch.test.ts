/**
 * OS で振る舞いを変えるなら、**渡せる形にする。**
 *
 * `process.platform` を関数の中で直に読むと、その枝は開発している OS でしか
 * 通らない。Windows むけの枝は、配ってから初めて動くことになる。
 * 「こちらでは動くが向こうでは動かない」は、ここから生まれる。
 *
 * 直に読んでよいのは**入口だけ**。入口が読んで、下へ渡す。下は渡された
 * ものだけを見る。そうすれば、どの OS ぶんもこの機械で試せる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 直に読んでよい場所。
 *
 * - 入口（`src/cli/`）: いま動いている OS を決めて、下へ渡す側
 * - 既定値として一度だけ読む所: `platform = process.platform` の形
 * - 表示するだけの所
 *
 * **増やさない。**増やすなら、渡せる形にできないか先に考える。
 */
const ALLOWED = new Set([
  'src/cli/doctor.ts',
  'src/cli/llama.ts',
  'src/cli/selftest.ts',
  'src/cli/ui.ts',
  'src/ui/server.ts',
]);

/**
 * 渡せる形になっているもの。ここは通してよい。
 *
 *   platform: NodeJS.Platform = process.platform   既定値として受け取る
 *   spawnPlan(cmd, process.platform)               呼ぶ側が渡している
 *   ctx.platform ?? process.platform               渡されていれば、そちらが勝つ
 *   { platform: process.platform }                 既定の入れ物を組む
 */
const AS_DEFAULT = /=\s*process\.platform|\?\?\s*process\.platform|:\s*process\.platform|,\s*process\.platform\s*\)|\(\s*process\.platform\s*\)/;

/** コメントの中の言及は、枝ではない。 */
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await sources(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('OS の枝を、この機械で試せる形にしておく', () => {
  test('**関数の中で process.platform を直に読まない**', async () => {
    const bad: string[] = [];
    for (const file of await sources(join(root, 'src'))) {
      const rel = file.slice(root.length + 1).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (!line.includes('process.platform')) return;
        if (COMMENT.test(line)) return; // コメントは枝ではない
        if (AS_DEFAULT.test(line)) return; // 渡せる形になっている
        bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(bad, [],
      `OS を引数で渡す形にしてください（この機械で試せなくなります）:\n  ${bad.join('\n  ')}`);
  });

  test('直に読んでよい場所を、増やしていない', async () => {
    // 入口以外が入っていたら、それは「渡せる形にできなかった」ということ。
    for (const rel of ALLOWED) {
      assert.ok(rel.startsWith('src/cli/') || rel === 'src/ui/server.ts',
        `入口でない場所が入っている: ${rel}`);
    }
  });
});
