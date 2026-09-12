/**
 * 本体は最近の記録を持ち、画面はそれを取り直す。
 *
 * 行を画面の DOM にしか持っていなかったので、描き直すたびに消えた（実機）。
 * ファイル（ui.log）には在るが、画面はそこを読まない。本体が最近の分を持つ。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

const dir = await tempDir('aas-logs-');
process.env.AAS_STATE_DIR = dir;
const { UiServer, RECENT_LOGS } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  server = new UiServer({ config: DEFAULT_CONFIG, port: 0 });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

type Line = { seq: number; level: string; text: string; at: string };
const lines = async (q = ''): Promise<Line[]> => ((await (await fetch(`${base}/api/logs${q}`)).json()) as { lines: Line[] }).lines;

describe('最近の記録を本体が持つ', () => {
  test('流した順に、番号付きで取り直せる', async () => {
    server.broadcast({ type: 'log', level: 'info', text: 'ひとつ' });
    server.broadcast({ type: 'log', level: 'warn', text: 'ふたつ' });
    const got = await lines();
    const mine = got.filter((l) => l.text === 'ひとつ' || l.text === 'ふたつ');
    assert.deepEqual(mine.map((l) => [l.text, l.level]), [['ひとつ', 'info'], ['ふたつ', 'warn']]);
    assert.ok(mine[1]!.seq > mine[0]!.seq, '番号が増えていない');
    assert.ok(!Number.isNaN(Date.parse(mine[0]!.at)), '時刻が無い');
    // 番号より後だけも取れる（開いているパネルが続きだけ欲しいとき）。
    const after = await lines(`?after=${mine[0]!.seq}`);
    assert.ok(after.every((l) => l.seq > mine[0]!.seq));
    assert.ok(after.some((l) => l.text === 'ふたつ'));
  });

  test('記録以外の出来事は入れない（対）', async () => {
    server.broadcast({ type: 'stateChanged' });
    server.broadcast({ type: 'busy', busy: true });
    const got = await lines();
    assert.ok(got.every((l) => typeof l.text === 'string' && typeof l.level === 'string'));
  });

  test(`${RECENT_LOGS} 行で頭から捨てる（溜め続けない）`, async () => {
    for (let i = 0; i < RECENT_LOGS + 50; i += 1) server.broadcast({ type: 'log', level: 'info', text: `行 ${i}` });
    const got = await lines();
    assert.equal(got.length, RECENT_LOGS);
    assert.equal(got[got.length - 1]!.text, `行 ${RECENT_LOGS + 49}`, '新しい方を残していない');
    assert.equal(got[0]!.text, '行 50', '古い方から捨てていない');
  });
});
