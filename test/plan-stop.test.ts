/**
 * 段取りを止めたら、確かめのコマンドを走らせない・止めた手を「駄目だった手」として覚えない。（01 / 01b）
 *
 * execCommand は、渡す前に止められていた signal の abort を拾わない。止めた後に plan が確かめへ進むと、
 * コマンドが最後まで走っていた。時刻には頼らない: 分解の問い合わせが届いた（requests > 0）のを見てから止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import { execCommand } from '../src/agent/shell-exec.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-plan-stop-state-');
const { Session } = await import('../src/core/session.ts');

const RAN = `node -e "require('fs').writeFileSync('ran.txt','1')"`;

test('止めた段取りは、確かめのコマンドを起こさない', async () => {
  const fake = await startFakeServer({ kind: 'hang' }); // 分解の返事が来ない
  const root = await tempDir('aas-plan-stop-root-');
  const session = await Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'], runtime: { kind: 'none' },
    agent: { root, approval: 'auto', maxTurns: 1, verify: { command: RAN, baseline: false } },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  try {
    const seen: string[] = [];
    const gen = session.plan('a.txt を作って');
    const draining = (async () => { for await (const ev of gen) seen.push(ev.type); })();
    // 分解の問い合わせが届くまで待つ（時刻ではなく、起きたことで待つ）
    while (fake.requests === 0) await new Promise((r) => setImmediate(r));
    session.abort();
    await draining;
    assert.ok(!seen.includes('verifying'), `止めたのに確かめへ進んだ: ${seen.join(',')}`);
    await assert.rejects(stat(join(root, 'ran.txt')), '止めたのに確かめのコマンドが走った');
    assert.equal(session.memory.all().filter((m) => m.source === 'plan').length, 0, '止めた手を覚えている');
  } finally {
    await session.close();
    await fake.close();
  }
});

test('止められた signal を渡された execCommand は、子を起こさない', async () => {
  const root = await tempDir('aas-exec-aborted-');
  const ac = new AbortController();
  ac.abort();
  const r = await execCommand(RAN, root, 600_000, ac.signal);
  assert.equal(r.aborted, true);
  await assert.rejects(stat(join(root, 'ran.txt')), '止めた後に子が走った');
});
