/**
 * 暇なときの考えごとは、始まった直後から ■ で止められる（DECISIONS 10-10、97 回目の調査）。
 *
 * 止め口を作るのが、選び・作業場の様子・手がかり探しを待った後だったので、その間に押した ■ は止める先が無く、
 * そのままモデルを呼んでいた。前の考えごとの記録があると見送られて試験にならないので、保存先を分けてある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const home = await tempDir('aas-think-stop-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
const { Session } = await import('../src/core/session.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('始まった直後に止めたら、モデルを呼ばずに終える（選び・様子見を待つ間も止め口がある）', async () => {
  const fake = await startFakeServer({ kind: 'stream', text: '見回りました。' });
  const work = join(home, 'work');
  await mkdir(work, { recursive: true });
  const session = await Session.create({
    ...DEFAULT_CONFIG,
    providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['p:m'],
    runtime: { kind: 'ollama' },
    agent: { root: work, approval: 'auto' },
  } as typeof DEFAULT_CONFIG, { approve: () => Promise.resolve(true) });
  try {
    const thinking = session.think()[Symbol.asyncIterator]();
    const firstStep = thinking.next();
    session.abort();
    const types: string[] = [];
    for (let r = await firstStep; !r.done; r = await thinking.next()) types.push(r.value.type + (r.value.type === "declined" ? ":" + (r.value as { reason: string }).reason : ""));
    assert.ok(!types.includes('chose'), `止めたのに選んで進んだ: ${types.join(',')}`);
    assert.equal(fake.requests, 0, '止めたのにモデルを呼んだ');
    assert.equal(session.busy, false, '止めた後に手を返していない');
  } finally {
    await session.close();
    await fake.close();
  }
});
