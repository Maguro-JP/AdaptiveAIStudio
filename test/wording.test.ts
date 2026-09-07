/**
 * 勝手な訳語を、増やさせない。
 *
 * CLAUDE.md には最初から「訳語を作らない」と書いてある。それでも
 * コンテキストウィンドウを「窓」、システムプロンプトを「前置き」、
 * repo map を「地図」と書き続けていた。**この置き場の中でしか通じない。**
 *
 * そのとき最初にやった直しが「CLAUDE.md に対応表を足す」で、これは
 * **読まなかった文章に、文章を足しただけ**だった。学びファイルにそのものが
 * 書いてある——「守らせたい決まりができたとき、CLAUDE.md に文章で書いて
 * 済ませた。読まないので守られない。実行の手前で止める形にする」。
 *
 * だからここで止める。
 *
 * ## 一括で置き換えない
 *
 * 見つかった時点で 1229 箇所・165 ファイル在った。まとめて置換すると、
 * 利用者に見せる文言や、試験が照合している文字列まで壊れる。
 * **上限を記録して、増やせないようにする。**触ったファイルから減らし、
 * 減ったらこの数字を下げる。上げるのは禁止。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 使わない語と、代わりに使う語。CLAUDE.md の対応表と同じもの。 */
const INSTEAD: Record<string, string> = {
  窓: 'コンテキストウィンドウ',
  前置き: 'システムプロンプト',
  地図: 'repo map',
  起点: 'seed',
  取り置き: '予約',
  置き場: 'リポジトリ',
  道具: 'ツール',
};

/**
 * いま残っている数の上限。**下げるのはよい。上げてはいけない。**
 *
 * 減らしたら、この数字も一緒に下げる。下げ忘れても落ちないので、
 * 「減らしたのに数字が合っていない」を見つけるための下限も置く。
 */
const CEILING: Record<string, number> = {
  窓: 325,
  前置き: 40,
  地図: 89,
  起点: 37,
  取り置き: 11,
  置き場: 277,
  道具: 415,
};

const LOOK_IN = ['src', 'scripts', 'test'];
const SKIP = new Set(['node_modules', 'dist', '.git']);

async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sources(full, out);
    else if (/\.(ts|mts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function counts(): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const word of Object.keys(INSTEAD)) found[word] = 0;
  for (const dir of LOOK_IN) {
    for (const file of await sources(join(root, dir))) {
      // この試験そのものは対応表を持っているので数えない。
      if (file.endsWith('wording.test.ts')) continue;
      const text = await readFile(file, 'utf8');
      for (const word of Object.keys(INSTEAD)) {
        found[word] = (found[word] ?? 0) + text.split(word).length - 1;
      }
    }
  }
  return found;
}

describe('勝手な訳語を増やさない', () => {
  test('**上限を超えていない**', async () => {
    const found = await counts();
    const over = Object.entries(found)
      .filter(([word, n]) => n > (CEILING[word] ?? 0))
      .map(([word, n]) => `${word}(${n} > ${CEILING[word]}) → ${INSTEAD[word]} を使う`);
    assert.deepEqual(over, [],
      `勝手な訳語が増えています。CLAUDE.md の対応表の右側を使ってください:\n  ${over.join('\n  ')}`);
  });

  test('減らしたら、上限も下げる', async () => {
    const found = await counts();
    const stale = Object.entries(found)
      .filter(([word, n]) => n < (CEILING[word] ?? 0))
      .map(([word, n]) => `${word}: ${CEILING[word]} → ${n} に下げる`);
    assert.deepEqual(stale, [],
      `減らしたのに上限がそのままです。test/wording.test.ts の CEILING を下げてください:\n  ${stale.join('\n  ')}`);
  });

  test('**今日書いたものには、一つも無い（対）**', async () => {
    for (const file of ['src/core/prompt-budget.ts', 'src/agent/rerank.ts', 'test/wording.test.ts']) {
      const text = await readFile(join(root, file), 'utf8');
      // この試験そのものは、対応表として語を持っているので数えない。
      const body = file.endsWith('wording.test.ts')
        ? text.slice(text.indexOf('const LOOK_IN'))
        : text;
      for (const word of Object.keys(INSTEAD)) {
        assert.ok(!body.includes(word), `${file} に「${word}」がある。${INSTEAD[word]} を使う`);
      }
    }
  });
});
