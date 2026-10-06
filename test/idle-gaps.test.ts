/**
 * 暇なときの考えごとと日課の不具合（47 回目の調査）。
 *
 * - PATROL が、考えごとの間は断られるコマンドを頼み、テストを一度も回さずに「済み」になっていた
 * - 見回りの手がかりが無いと、数えずに空振りし続け、ほかの考えごとが一度も選ばれなかった
 * - 設定の `initiative.maxOpen` が読まれず、10 の決め打ちだった
 *
 * 端末の Ctrl-C・画面の「考える」の後の順番待ち・端末の既定・`/idle` の表示は、端末と画面の中の直しで、ここでは試験を書いていない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';

describe('未処理の提案の上限', () => {
  test('**設定の maxOpen で止まる**（10 の決め打ちだった）', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 12, maxOpen: 3 });
    const now = Date.UTC(2026, 9, 6, 3);
    const d = await s.choose({ lastChangeAt: now - 60_000, openProposals: 3, now });
    assert.equal(d.mode, undefined);
    assert.match(d.reason ?? '', /溜まって/);
    const below = await s.choose({ lastChangeAt: now - 60_000, openProposals: 2, now });
    assert.ok(below.mode, `上限の手前で止めた: ${below.reason}`);
  });
});

describe('考えごと', { timeout: 120_000 }, () => {
  let fake: FakeServer;
  before(async () => { fake = await startFakeServer({ kind: 'stream', text: 'はい。' }); });
  after(async () => { await fake.close(); });

  async function session(modes: string[]) {
    process.env.AAS_STATE_DIR = await tempDir('aas-idle-gaps-state-');
    const root = await tempDir('aas-idle-gaps-root-');
    await writeFile(join(root, 'a.txt'), 'a\n');
    const { Session } = await import('../src/core/session.ts');
    const s = await Session.create({
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 3, verify: { enabled: false } },
      initiative: { enabled: true, modes },
    } as never, { approve: () => Promise.resolve(true) });
    s.markChanged(Date.now());
    return s;
  }

  async function events(s: { think(): AsyncGenerator<{ type: string; reason?: string }, boolean> }) {
    const got: Array<{ type: string; reason?: string }> = [];
    for await (const ev of s.think()) got.push(ev);
    return got;
  }

  test('**PATROL でコマンドを断られた回は「済み」にも提案にもせず、テストを回していないと言う**', async () => {
    const s = await session(['patrol']);
    try {
      fake.setBehavior({ kind: 'steps', calls: [{ name: 'run_command', args: { command: 'npm test' } }], then: 'テストを流せませんでした。' });
      const got = await events(s);
      assert.ok(got.some((e) => e.type === 'chose'), `前提: PATROL を選んでいない: ${JSON.stringify(got)}`);
      const last = got.at(-1)!;
      assert.equal(last.type, 'failed', `テストを回していないのに済ませた: ${JSON.stringify(got)}`);
      assert.match(last.reason ?? '', /テストは回していません/);
      assert.equal(got.some((e) => e.type === 'proposal'), false, '「テストできなかった」を提案にした');
      // 日課を済ませた数は増えない（日課として選ばれていれば、流した数が増える）
      for (const d of s.duties.status(Date.now()).filter((x) => x.duty.modeId === 'patrol')) {
        assert.equal(d.record.completions, 0, 'テストを回していないのに、日課を済ませたことにした');
      }
    } finally {
      await s.close();
      delete process.env.AAS_STATE_DIR;
    }
  });

  test('**見回りの手がかりが無いときは、無いと言い、見回りを見たことにする**（次の選びで同じ空振りを繰り返さない）', async () => {
    const s = await session(['recon']);
    try {
      const got = await events(s);
      const last = got.at(-1);
      assert.equal(last?.type, 'declined', `黙って終えた: ${JSON.stringify(got)}`);
      assert.match(last?.reason ?? '', /手がかり|様子/);
      const next = await s.nextThought();
      assert.notEqual(next.mode?.id, 'recon', '空振りした見回りを、同じ変更でまた選ぶ');
    } finally {
      await s.close();
      delete process.env.AAS_STATE_DIR;
    }
  });
});
