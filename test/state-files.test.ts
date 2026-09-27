/**
 * 覚えておくファイル（当番の記録・マシンの検出結果）の形が違うとき、画面の一覧や doctor ごと止めない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

  test('正しい検出結果は、検出し直さずにそのまま使う（対）', async () => {
    const dir = await tempDir('aas-machine-ok-');
    const path = join(dir, 'machine.json');
    const spec = { vramBytes: 0, ramBytes: 8 * 2 ** 30, ramBandwidthBytesPerSec: 1, vramBandwidthBytesPerSec: 0, bandwidthEstimated: true, gpuName: 'テスト' };
    await writeFile(path, JSON.stringify(spec));
    assert.deepEqual(await new MachineCache(path).get(), spec);
  });
});
