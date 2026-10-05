/**
 * 暇なときの考えごとは、手を取ってから「選びました」と言う（DECISIONS 10-05、35 回目の調査）。
 *
 * 考えごとは、手が空いているかを最初に一度見て、そのあと何度も待つ（見回り・手がかり探し・「選びました」の知らせ）。
 * 手を取るのはその後だったので、待っている間に来た送りが空いた手を取り、考えごとがその止め口を上書きして、終わりに空にしていた
 * （止めるボタンが送りに効かず、送りの途中で手が空いたことになる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const home = await tempDir('aas-think-busy-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
const { Session } = await import('../src/core/session.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('「選びました」と言った時点で、もう手を取っている（その間に来た送りに手を渡さない）', async () => {
  const fake = await startFakeServer({ kind: 'stream', text: '見回りました。気になる所はありません。' });
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
    assert.equal(session.busy, false);
    const thinking = session.think()[Symbol.asyncIterator]();
    let first = await thinking.next();
    while (!first.done && first.value.type !== 'chose') first = await thinking.next();
    assert.ok(!first.done, '選ばなかった（この試験の前提が崩れた）');
    assert.equal(session.busy, true, '「選びました」の時点で手を取っていない（この間に来た送りが手を取る）');
    // 最後まで回すと手を返す
    for (let r = await thinking.next(); !r.done; r = await thinking.next()) { /* 流す */ }
    assert.equal(session.busy, false, '考え終えても手を返していない');
  } finally {
    await session.close();
    await fake.close();
  }
});
