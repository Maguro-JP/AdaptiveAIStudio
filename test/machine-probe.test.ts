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

test('名前はあるのに量が数でない（[N/A]）ときは、GPU なしと決めつけず、調べ切れなかった扱いにする', async () => {
  const { parseNvidiaSmi } = await import('../src/runtime/machine.ts');
  assert.equal(parseNvidiaSmi('NVIDIA GB10, [N/A]\n'), 'timeout');
  assert.equal(parseNvidiaSmi('NVIDIA Jetson, Not Supported'), 'timeout');
});

test('量が数なら読み、出力が無ければ GPU なし（対）', async () => {
  const { parseNvidiaSmi } = await import('../src/runtime/machine.ts');
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\n'), { name: 'NVIDIA GeForce RTX 3060', vramBytes: 12288 * 1024 * 1024 });
  assert.equal(parseNvidiaSmi(undefined), undefined);
  assert.equal(parseNvidiaSmi(''), undefined);
});
