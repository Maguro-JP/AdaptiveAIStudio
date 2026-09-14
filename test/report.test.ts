/**
 * 困ったときの報告は、押したら一つのファイルになる。
 * 要るものが揃い、トークンの値は出ず、テストの結果と記録の末尾が入る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';

const home = await tempDir('aas-report-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
process.env.AAS_CONFIG = join(home, 'aas.config.json');
const { buildReport, redactSecrets } = await import('../src/cli/report.ts');
const { saveReport } = await import('../src/cli/report-file.ts');

describe('困ったときの報告', () => {
  test('トークンの値を伏せる。名前は残す', () => {
    const out = redactSecrets('{"apiKey":"sk-123","envFrom":{"GITHUB_TOKEN":"MY_TOKEN"},"password":"p","name":"ok"}');
    assert.ok(!out.includes('sk-123') && !out.includes('"p"'), out);
    assert.ok(out.includes('"apiKey"') && out.includes('"name":"ok"'), out);
    // envFrom の値は環境変数の名前。値ではないが、名前に TOKEN を含むので伏せる側に倒す（安全側）。
    assert.ok(!out.includes('MY_TOKEN'), out);
  });

  test('版・機械・設定・モデル・doctor・記録・点検が一つに揃う', async () => {
    const state = join(home, 'state');
    const models = join(home, 'models');
    await mkdir(join(state, 'logs'), { recursive: true });
    await mkdir(join(state, 'reports'), { recursive: true });
    await mkdir(models, { recursive: true });
    await writeFile(join(home, 'aas.config.json'), '{"runtime":{"kind":"inproc"},"secretToken":"HIDE-ME"}');
    await writeFile(join(state, 'machine.json'), '{"gpuName":null,"ramBytes":1}');
    await writeFile(join(state, 'logs', 'ui.log'), Array.from({ length: 500 }, (_, i) => `2026-09-11 00:00:00 [info] line ${i}`).join('\n') + '\n');
    await writeFile(join(state, 'audit.jsonl'), '{"a":1}\n{"a":2}\n');
    await writeFile(join(state, 'reports', 'test-20260911-0100.txt'), 'not ok 1 - 古い\n');
    await writeFile(join(state, 'reports', 'test-20260911-0200.txt'), 'not ok 9 - 新しい\n');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    const body = await buildReport({ root: process.cwd(), state, home, models, doctor: async () => 'DOCTOR-OUT 動かせます' });
    for (const must of ['## 版', 'Node: v', '## 機械', '"gpuName"', '## 設定', '"secretToken"', '## モデル', 'a.gguf', '## doctor', 'DOCTOR-OUT', '## 直近の記録', 'line 499', '## 直近の操作', '{"a":2}', '直近の点検: test', 'not ok 9 - 新しい']) {
      assert.ok(body.includes(must), `無い: ${must}`);
    }
    assert.ok(!body.includes('HIDE-ME'), 'トークンの値が出ている');
    assert.ok(!body.includes('line 0\n'), '記録の頭まで全部入れている（末尾だけでよい）');
    assert.ok(!body.includes('古い'), '古い点検の結果を入れている');
  });

  test('直近の doctor が新しければ、使い回す（毎回 1〜2 分回さない）', async () => {
    const dir = await tempDir('aas-report-reuse-');
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'doctor-20260912-1200.txt'), 'CACHED-DOCTOR よい状態です\n');
    let ran = false;
    const body = await buildReport({
      root: dir, state: dir, home, models: join(dir, 'models'),
      doctor: async () => { ran = true; return 'FRESH-RUN'; },
    });
    assert.equal(ran, false, '新しい doctor があるのに回している');
    assert.ok(body.includes('CACHED-DOCTOR'), '使い回した中身が入っていない');
    assert.ok(body.includes('使い回しました'), '使い回したと言っていない');
    assert.ok(!body.includes('FRESH-RUN'), '使い回すはずが回している');
  });

  test('直近の doctor が古ければ、その場で回す（対）', async () => {
    const dir = await tempDir('aas-report-stale-');
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'doctor-20260912-1200.txt'), 'CACHED-DOCTOR\n');
    let ran = false;
    const body = await buildReport({
      root: dir, state: dir, home, models: join(dir, 'models'),
      doctorMaxAgeMs: 0, // どんな控えも「古い」扱いにする
      doctor: async () => { ran = true; return 'FRESH-RUN その場で回した'; },
    });
    assert.equal(ran, true, '古い doctor しかないのに回していない');
    assert.ok(body.includes('FRESH-RUN'), '回した結果が入っていない');
    assert.ok(body.includes('その場で doctor を回しました'), '回したと言っていない');
  });

  test('置く先を AAS_REPORT_DIR で変えられる（テストがプログラムの隣に撒かないため）', async () => {
    const dir = await tempDir('aas-report-dir-');
    const prev = process.env.AAS_REPORT_DIR;
    process.env.AAS_REPORT_DIR = dir;
    try {
      const saved = await saveReport('report', 'x', ['/proc/aas-cannot']);
      assert.ok(saved.path?.startsWith(dir), JSON.stringify(saved));
      assert.equal(await readFile(saved.path!, 'utf8'), 'x');
    } finally {
      if (prev === undefined) delete process.env.AAS_REPORT_DIR; else process.env.AAS_REPORT_DIR = prev;
    }
  });
});
