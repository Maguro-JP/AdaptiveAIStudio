/**
 * サポート用レポートは、押したら裏でまとまり、出来た場所が返る。
 *
 * 診断の一覧ではなく、`/api/report` の一つの口。作るのは分単位なので
 * 202 で受け取り、GET で追う。走っている間に二度押しても、二つ作らない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-report-ui-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { TASKS } = await import('../src/ui/tasks.ts');

describe('サポート用レポート', () => {
  test('押したら 202、出来たら場所が返り、中身が残っている', async () => {
    let builds = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const s = new UiServer({
      port: 0,
      buildReport: async () => { builds++; await gate; return 'REPORT BODY'; },
      config: { ...DEFAULT_CONFIG, initiative: { enabled: false } } as typeof DEFAULT_CONFIG,
    });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      assert.deepEqual((await (await fetch(`${base}/api/report`)).json()), { report: null });
      const first = await fetch(`${base}/api/report`, { method: 'POST' });
      assert.equal(first.status, 202);
      const again = await fetch(`${base}/api/report`, { method: 'POST' });
      assert.equal(again.status, 409, '走っている間の二度押しで二つ作っている');
      const running = await (await fetch(`${base}/api/report`)).json() as { report: { state: string } };
      assert.equal(running.report.state, 'running');
      release();
      let rep: { state: string; path?: string; message: string } | undefined;
      await until(async () => {
        rep = ((await (await fetch(`${base}/api/report`)).json()) as { report: typeof rep }).report;
        return rep?.state === 'done';
      }, '出来上がる');
      assert.ok(rep?.path, '出来た場所が無い');
      assert.equal(await readFile(rep!.path!, 'utf8'), 'REPORT BODY');
      assert.ok(rep!.path!.startsWith(join(dir, 'state', 'reports')), `置き先が違う: ${rep!.path}`);
      assert.equal(builds, 1);
    } finally {
      await s.stop();
    }
  });

  test('診断の一覧には無い（別の口）', () => {
    assert.ok(!('report' in TASKS));
  });
});
