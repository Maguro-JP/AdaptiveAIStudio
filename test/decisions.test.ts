/**
 * docs/DECISIONS.md の読む順が、中身とずれていないことを見る。
 *
 * 目次は放っておくと腐る。節を足したのに目次へ書かない、
 * 節の名を変えたのに目次が古いまま、のどちらも起きる。
 * **目次に在る名前と、節の名前が、双方向で一致すること**を見る。
 * 片側だけ見ると「目次を空にすれば通る」検査になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 読んだ中身の行末を LF にそろえてから見る。
 *
 * Windows の checkout は CRLF になる。そろえずに `\n## 読む順\n` を探すと
 * 一つも当たらず、中身は正しいのに「読む順の節が無い」と言って落ちた
 * （Windows の CI で実際にそう落ちた）。`split('\n')` の側も、題の末尾に
 * `\r` が残って名前が一致しなくなる。
 *
 * ここで見たいのは目次と節の対応であって行末ではないので、
 * **読んだ直後にそろえる。**走らせる場所で結果が変わらないようにする。
 */
async function readLf(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
}

/** 見出しから、日付を落とした題だけを取り出す。 */
function headings(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^## (\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/.exec(line);
    if (m) found.push(m[2]!);
  }
  return found;
}

/** 「## 読む順」の中の箇条書きを取り出す。 */
function indexed(text: string): string[] {
  const start = text.indexOf('\n## 読む順\n');
  assert.notEqual(start, -1, '読む順の節が無い');
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n---');
  const body = end === -1 ? rest : rest.slice(0, end);
  return body
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

describe('決めたことの目次', () => {
  test('目次の名前は、すべて節として在る', async () => {
    const text = await readLf(join(root, 'docs/DECISIONS.md'));
    const titles = new Set(headings(text));
    assert.ok(titles.size > 0, '節が読めていない');
    for (const name of indexed(text)) {
      assert.ok(titles.has(name), `目次に在るが節が無い: ${name}`);
    }
  });

  test('節は、すべて目次に載っている', async () => {
    const text = await readLf(join(root, 'docs/DECISIONS.md'));
    const listed = new Set(indexed(text));
    for (const name of headings(text)) {
      assert.ok(listed.has(name), `節が在るのに目次に無い: ${name}`);
    }
  });
});
