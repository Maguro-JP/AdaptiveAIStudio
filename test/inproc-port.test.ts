/**
 * モデルの口を、始める前に決める。
 *
 * この中で読む道は 4177 で待つ。もう一つ立ち上がっていたり、前のものが
 * 残っていたりすると埋まっていて、**モデルを読むところで初めて失敗する。**
 * 押した人には「モデルが読めない」としか見えない（この機械で三度踏んだ）。
 *
 * 空いている番号を選べば起きない。**0（何でもよい）にはしない。**繋ぐ側は
 * 設定から番号を組み立てるので、決めた番号を書き戻せる形にしておく。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freePortFrom } from '../src/runtime/inproc.ts';

describe('空いている口を選ぶ', () => {
  test('空いていれば、そのまま使う', async () => {
    assert.equal(await freePortFrom(4177, 5, () => Promise.resolve(true)), 4177);
  });

  test('埋まっていれば、次を試す', async () => {
    const busy = new Set([4177, 4178]);
    const got = await freePortFrom(4177, 5, (p) => Promise.resolve(!busy.has(p)));
    assert.equal(got, 4179);
  });

  test('どれも埋まっていれば、決めない', async () => {
    // 決められないのに番号を返すと、繋ぐ側と待つ側が別を向く。
    assert.equal(await freePortFrom(4177, 3, () => Promise.resolve(false)), undefined);
  });

  test('本当に開ける口を選ぶ（モックを使わずに）', async () => {
    const { createServer } = await import('node:net');
    const held = createServer();
    const port = await new Promise<number>((ok) => {
      held.listen(0, '127.0.0.1', () => ok((held.address() as { port: number }).port));
    });
    try {
      const got = await freePortFrom(port, 5);
      assert.notEqual(got, port, '埋まっている口を選んでいる');
      assert.ok(got !== undefined && got > port, `近い番号から選んでいない: ${got}`);
    } finally {
      await new Promise<void>((ok) => held.close(() => ok()));
    }
  });
});
