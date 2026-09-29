/**
 * 機械の検出で走らせる命令（nvidia-smi）が返らないとき、待ち続けない。
 *
 * ドライバが固まって nvidia-smi が返らないと、検出を待つ送信の前処理ごと止まり、送った依頼が全部順番待ちのまま・■も効かない、に
 * なっていた。返らない命令の代わりに、眠り続ける node を走らせて見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../src/runtime/machine.ts';

test('返らない命令は、時間切れで打ち切って「取れなかった」にする', async () => {
  const started = Date.now();
  const out = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 300);
  assert.equal(out, undefined);
  assert.ok(Date.now() - started < 10_000, `時間切れで打ち切っていない（${Date.now() - started}ms）`);
});

test('すぐ返る命令は、今までどおり出力を返す（対）', async () => {
  assert.equal((await runProbe(process.execPath, ['-e', 'process.stdout.write("ok")']))?.trim(), 'ok');
});
