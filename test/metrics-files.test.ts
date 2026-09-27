/**
 * ハーネスの記録（`harness-metrics.json`）と、モデルの実測の記録（`metrics.json`）を、
 * 形の違う一件で全部捨てない・読めないときに空で上書きしない・数を文字にしない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { HarnessMetrics } from '../src/harness/metrics.ts';
import { MetricsStore } from '../src/runtime/metrics.ts';

const rule = (denials: number) => ({ rule: 'r', denials, recovered: denials, abandoned: 0, warnings: 0 });

describe('ハーネスの記録', () => {
  test('**形の違う一件（null・数でない回数）はその一件だけ除き、残りは読む**', async () => {
    const dir = await tempDir('aas-hmf-');
    const path = join(dir, 'harness-metrics.json');
    await writeFile(path, JSON.stringify({
      stats: [null, { ...rule(1), rule: 'x', denials: '5' }, { ...rule(1), rule: 'y', warnings: -1 }, rule(4)],
      tasks: 6, cleanTasks: 2,
    }));
    const m = new HarnessMetrics(path);
    await m.load();
    const report = m.report(['r', 'x', 'y']);
    assert.equal(report.tasks, 6);
    assert.deepEqual(report.rules.map((r) => r.denials), [4, 0, 0]);
    m.beginTask(); m.recordDenial('x'); m.endTask('completed');
    assert.equal(m.report(['x']).rules[0]!.denials, 1, '文字の回数に足した');
  });

  for (const [name, text] of [['null', 'null'], ['配列', '[]'], ['数でない依頼の数', '{"stats":[],"tasks":"6","cleanTasks":1}']] as const) {
    test(`**記録が${name}でも、依頼の数を数として数える**`, async () => {
      const dir = await tempDir('aas-hmf-');
      const path = join(dir, 'harness-metrics.json');
      await writeFile(path, text);
      const m = new HarnessMetrics(path);
      await m.load();
      m.beginTask(); m.endTask('completed');
      const report = m.report([]);
      assert.equal(report.tasks, 1);
      assert.equal(report.cleanTaskRatio, 1);
    });
  }

  test('**拒否の無い依頼の数が依頼の数を超える記録でも、割合を 100% より上にしない**', async () => {
    const dir = await tempDir('aas-hmf-');
    const path = join(dir, 'harness-metrics.json');
    await writeFile(path, JSON.stringify({ stats: [], tasks: 2, cleanTasks: 9 }));
    const m = new HarnessMetrics(path);
    await m.load();
    assert.equal(m.report([]).cleanTaskRatio, 1);
  });

  test('**在るのに読めないときは書かない。読めたら足して書く**', async () => {
    const dir = await tempDir('aas-hmf-');
    const path = join(dir, 'harness-metrics.json');
    await mkdir(path); // 読めない（EISDIR）
    const m = new HarnessMetrics(path);
    await m.load();
    m.beginTask(); m.recordDenial('r'); m.endTask('completed');
    await m.save();
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ stats: [rule(4)], tasks: 6, cleanTasks: 2 }));
    await m.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { stats: { denials: number }[]; tasks: number; cleanTasks: number };
    assert.equal(saved.tasks, 7, '読めなかった間の空で上書きした');
    assert.equal(saved.cleanTasks, 2);
    assert.equal(saved.stats[0]!.denials, 5);
    assert.deepEqual(await readdir(dir), ['harness-metrics.json']);
  });
});

describe('モデルの実測の記録', () => {
  const stat = (successes: number, extra: Record<string, unknown> = {}) =>
    ({ modelId: 'm', successes, failures: 1, measuredTps: 20, ...extra });

  test('**形の違う一件（null・数でない回数・負の実測）はその一件だけ除き、残りは読む**', async () => {
    const dir = await tempDir('aas-msf-');
    const path = join(dir, 'metrics.json');
    await writeFile(path, JSON.stringify([
      null,
      stat(1, { modelId: 'a', successes: '3' }),
      stat(1, { modelId: 'b', measuredTps: -5 }),
      stat(1, { modelId: 'c', defects: 1.5 }),
      stat(4),
    ]));
    const store = new MetricsStore(path);
    await store.load();
    assert.deepEqual(store.all().map((s) => s.modelId), ['m']);
    store.record({ modelId: 'a', success: true, outputTokens: 0, seconds: 0 });
    assert.equal(store.get('a')!.successes, 1, '文字の回数に足した');
  });

  for (const [name, text] of [['null', 'null'], ['入れ物', '{"m":1}']] as const) {
    test(`**記録が${name}でも止めず、測ったら書く**`, async () => {
      const dir = await tempDir('aas-msf-');
      const path = join(dir, 'metrics.json');
      await writeFile(path, text);
      const store = new MetricsStore(path);
      await store.load();
      store.record({ modelId: 'm', success: true, outputTokens: 0, seconds: 0 });
      await store.save();
      assert.equal((JSON.parse(await readFile(path, 'utf8')) as { successes: number }[])[0]!.successes, 1);
    });
  }

  test('**在るのに読めないときは書かない。読めたら回数を足し、この間に測った実測を取る**', async () => {
    const dir = await tempDir('aas-msf-');
    const path = join(dir, 'metrics.json');
    await mkdir(path); // 読めない（EISDIR）
    const store = new MetricsStore(path);
    await store.load();
    store.record({ modelId: 'm', success: true, outputTokens: 100, seconds: 2 }); // 50 tok/s
    await store.save();
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify([stat(4, { defects: 2, loadSeconds: 7 }), { modelId: 'k', successes: 1, failures: 0 }]));
    await store.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>[];
    const m = saved.find((s) => s.modelId === 'm')!;
    assert.equal(m.successes, 5, '読めなかった間の空で上書きした');
    assert.equal(m.failures, 1);
    assert.equal(m.defects, 2);
    assert.equal(m.measuredTps, 50, '古い実測で、この間に測った値を上書きした');
    assert.equal(m.loadSeconds, 7);
    assert.ok(saved.some((s) => s.modelId === 'k'), '測っていないモデルの分を落とした');
    assert.deepEqual(await readdir(dir), ['metrics.json']);
  });
});
