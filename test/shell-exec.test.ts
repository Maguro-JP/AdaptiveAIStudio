/**
 * コマンド実行の検証。
 * 上限で打ち切ったとき、殻の下の本体まで止まることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execCommand } from '../src/agent/shell-exec.ts';

/**
 * 打ち切られた後も生きていれば、印を書き足してしまう子。
 * 置き場は環境変数で渡す。Windows のパスは引数に載せると殻の解釈で崩れる。
 */
const SURVIVOR = `
import { writeFileSync } from 'node:fs';
setTimeout(() => writeFileSync(process.env.MARKER, 'survived'), 1500);
setTimeout(() => {}, 30_000);
`;

describe('execCommand', () => {
  test('時間上限で打ち切ると、その下の処理も止まる', async () => {
    const root = await tempDir('aas-exec-');
    try {
      await writeFile(join(root, 'survivor.mjs'), SURVIVOR);
      const marker = join(root, 'marker.txt');

      process.env.MARKER = marker;
      const started = Date.now();
      const r = await execCommand('node survivor.mjs', root, 300, new AbortController().signal);
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 10_000, '上限で戻ること');

      // 打ち切った後も生きていれば、この間に印が書かれる。
      await delay(2500);
      assert.equal(
        await readFile(marker, 'utf8').catch(() => null), null,
        '打ち切った処理が生き残って走り続けている',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('中断でも同じように止まる', async () => {
    const root = await tempDir('aas-exec-');
    try {
      await writeFile(join(root, 'survivor.mjs'), SURVIVOR);
      const marker = join(root, 'marker.txt');
      process.env.MARKER = marker;
      const ac = new AbortController();
      const run = execCommand('node survivor.mjs', root, 30_000, ac.signal);
      await delay(200);
      ac.abort();
      const r = await run;
      assert.equal(r.aborted, true);

      await delay(2500);
      assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('通常の終了は今までどおり結果を返す', async () => {
    const root = await tempDir('aas-exec-');
    try {
      const r = await execCommand('echo hello', root, 10_000, new AbortController().signal);
      assert.equal(r.code, 0);
      assert.equal(r.timedOut, false);
      assert.match(r.output, /hello/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
