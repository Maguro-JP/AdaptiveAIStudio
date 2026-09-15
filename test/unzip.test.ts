/**
 * zip を自前で開けるか。
 *
 * 検査用の zip は python の zipfile で作ってある（test/fixtures/sample.zip）。
 * **自作の書き出しで作った zip を自作の読み取りで読んでも、証明にならない**ため、
 * 別の実装が作った本物を相手にする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unzip } from '../src/runtime/unzip.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sample = await readFile(join(here, 'fixtures', 'sample.zip'));

describe('zip の読み取り', () => {
  test('中身を全部取り出せる', () => {
    const entries = unzip(sample);
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['build/bin/README.txt', 'build/bin/llama-server', 'build/bin/run.sh']);
  });

  test('圧縮されているものを展開できる（deflate）', () => {
    const e = unzip(sample).find((x) => x.path.endsWith('llama-server'));
    assert.ok(e);
    assert.equal(e.data.toString('utf8'), 'これは実行ファイルのつもり\n'.repeat(40));
  });

  test('圧縮していないものも読める（stored）', () => {
    const e = unzip(sample).find((x) => x.path.endsWith('README.txt'));
    assert.equal(e?.data.toString('utf8'), 'ちいさい\n');
  });

  test('実行できるかどうかを引き継ぐ', () => {
    const entries = unzip(sample);
    assert.equal(entries.find((e) => e.path.endsWith('run.sh'))?.executable, true,
      '実行ビットが落ちている（取り出しても動かせない）');
    assert.equal(entries.find((e) => e.path.endsWith('README.txt'))?.executable, false);
  });

  test('ディレクトリそのものは項目にしない', () => {
    assert.ok(!unzip(sample).some((e) => e.path.endsWith('/')));
  });

  test('zip でないものは、そう言って断る', () => {
    assert.throws(() => unzip(Buffer.from('これは zip ではありません')), /zip として読めません/);
  });

  test('壊れていれば、黙って空を返さない', () => {
    // 末尾の目印だけ残して中身を削る
    const broken = Buffer.concat([Buffer.alloc(64), sample.subarray(sample.length - 22)]);
    assert.throws(() => unzip(broken));
  });
});
