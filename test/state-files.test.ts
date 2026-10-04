/**
 * 覚えておくファイル（当番の記録・マシンの検出結果）の形が違うとき、画面の一覧や doctor ごと止めない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { tempDir } from './tmp.ts';
import { dutyBoard } from '../src/ui/state.ts';
import { MachineCache, describeMachine } from '../src/runtime/machine.ts';
import { BUILTIN_DUTIES } from '../src/harness/builtin-duties.ts';

describe('当番の記録', () => {
  test('**形の違う一件（null・数でない回数）があっても、画面の当番の一覧を止めず、正しい一件は使う**', () => {
    const id = BUILTIN_DUTIES[0]!.id;
    const records = [null, { dutyId: 'x' }, { dutyId: id, completions: 3, missed: 1 }, { dutyId: id + 'y', completions: 'many', missed: 0 }];
    let board: ReturnType<typeof dutyBoard> = [];
    assert.doesNotThrow(() => { board = dutyBoard(records as never, Date.now()); });
    const mine = board.find((b) => b.id === id)!;
    assert.equal(mine.completions, 3);
    assert.equal(mine.missed, 1);
  });

  test('**仕込まれた当番の記録でも、回数が数でない一件は使わない**（使うと、足したときに "many1" という文字になる）', () => {
    const id = BUILTIN_DUTIES[1]!.id;
    const board = dutyBoard([{ dutyId: id, completions: 'many', missed: 0, lastPeriod: 'x' }] as never, Date.now());
    const mine = board.find((b) => b.id === id)!;
    assert.equal(typeof mine.completions, 'number');
    assert.equal(mine.completions, 0);
  });
});

describe('マシンの検出結果', () => {
  for (const [name, text] of [['null', 'null'], ['空の入れ物', '{}'], ['配列', '[]'], ['壊れた JSON', '{"ramBytes":']] as const) {
    test(`**検出結果が${name}なら、検出し直して書き直す（doctor を落とさず、NaN のまま使わない）**`, async () => {
      const dir = await tempDir('aas-machine-');
      const path = join(dir, 'machine.json');
      await writeFile(path, text);
      const m = await new MachineCache(path).get();
      assert.ok(Number.isFinite(m.ramBytes) && m.ramBytes > 0, `RAM が数でない: ${m.ramBytes}`);
      assert.doesNotThrow(() => describeMachine(m));
      assert.doesNotMatch(describeMachine(m), /NaN/);
      const saved = JSON.parse(await readFile(path, 'utf8')) as { ramBytes: number };
      assert.ok(saved.ramBytes > 0, '書き直していない');
      assert.ok((await readdir(dir)).every((n) => !n.endsWith('.tmp')), '一時ファイルが残った');
    });
  }

  test('RAM が 0 の検出結果は、検出し直す', async () => {
    const dir = await tempDir('aas-machine-zero-');
    const path = join(dir, 'machine.json');
    await writeFile(path, JSON.stringify({ vramBytes: 0, ramBytes: 0, ramBandwidthBytesPerSec: 1, vramBandwidthBytesPerSec: 0, bandwidthEstimated: true }));
    assert.ok((await new MachineCache(path).get()).ramBytes > 0);
  });

  test('**この機械で検出した結果（GPU が無い形も）は、二度目は書き直さずに使う**', async () => {
    const dir = await tempDir('aas-machine-real-');
    const path = join(dir, 'machine.json');
    const first = await new MachineCache(path).get();
    const ino = (await stat(path)).ino;
    const again = await new MachineCache(path).get();
    assert.deepEqual(again, first);
    assert.equal((await stat(path)).ino, ino, '正しい検出結果を退けて書き直した');
    // 製品の GPU の無い形（gpuName が無く、ディスクの帯域が在る）もそのまま使う。
    const noGpu = { vramBytes: 0, ramBytes: totalmem(), ramBandwidthBytesPerSec: 40 * 2 ** 30, vramBandwidthBytesPerSec: 0, diskBandwidthBytesPerSec: 2 ** 30, bandwidthEstimated: true, detectedAt: Date.now() };
    await writeFile(path, JSON.stringify(noGpu));
    const ino2 = (await stat(path)).ino;
    assert.deepEqual(await new MachineCache(path).get(), noGpu);
    assert.equal((await stat(path)).ino, ino2);
  });

  test('正しい検出結果は、検出し直さずにそのまま使う（対）', async () => {
    const dir = await tempDir('aas-machine-ok-');
    const path = join(dir, 'machine.json');
    const spec = { vramBytes: 0, ramBytes: totalmem(), ramBandwidthBytesPerSec: 1, vramBandwidthBytesPerSec: 0, bandwidthEstimated: true, gpuName: 'テスト', detectedAt: Date.now() };
    await writeFile(path, JSON.stringify(spec));
    assert.deepEqual(await new MachineCache(path).get(), spec);
  });

  const NOW = Date.UTC(2026, 9, 4);
  const detected = (over: Record<string, unknown> = {}) => ({
    vramBytes: 0, ramBytes: totalmem(), ramBandwidthBytesPerSec: 1, vramBandwidthBytesPerSec: 0, bandwidthEstimated: true, detectedAt: NOW, ...over,
  });

  test('**古い・RAM が違う・時刻の無い検出結果は取り直す**（後から入れた GPU のドライバ・足した RAM を拾う）', async () => {
    const path = join(await tempDir('aas-machine-ttl-'), 'machine.json');
    let calls = 0;
    const cache = (now: number) => new MachineCache(path, { now: () => now, detect: async () => { calls++; return detected({ detectedAt: now, gpuName: 'new' }); } });
    for (const old of [
      detected({ detectedAt: NOW - 8 * 86_400_000 }),
      detected({ ramBytes: totalmem() + 2 ** 30 }),
      { ...detected(), detectedAt: undefined },
    ]) {
      await writeFile(path, JSON.stringify(old));
      assert.equal((await cache(NOW).get()).gpuName, 'new', JSON.stringify(old));
    }
    assert.equal(calls, 3);
    assert.equal((await cache(NOW + 86_400_000).get()).gpuName, 'new', '取り直した結果は、次から使う');
    assert.equal(calls, 3);
  });

  test('**GPU を調べ切れなかった結果は残さず、次に調べ直す**（「GPU なし」を使い続けない）', async () => {
    const path = join(await tempDir('aas-machine-unsure-'), 'machine.json');
    let unsure = true;
    const cache = new MachineCache(path, { now: () => NOW, detect: async () => (unsure ? detected({ gpuUnsure: true }) : detected({ vramBytes: 8 * 2 ** 30, gpuName: 'RTX' })) });
    assert.equal((await cache.get()).gpuUnsure, true);
    await assert.rejects(stat(path), '調べ切れなかった結果を書いた');
    unsure = false;
    assert.equal((await cache.get()).gpuName, 'RTX');
  });
});
