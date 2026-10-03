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
    // 上限つきで待つ（分解の問い合わせまで届かない壊れ方で、試験全体を止めない）
    for (let i = 0; i < 20_000 && fake.requests === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(fake.requests > 0, '分解の問い合わせが届かない');
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

/*
 * 送り口で、担当の後の確かめの最中に止めたら「止めた」で終える。担当の終わり方（completed）だけで決めていたので、確かめを
 * 止めても completed のまま返り、一歩ずつの段では「済んだ」として次の段が勝手に始まっていた。
 * 時刻には頼らない: 確かめのコマンドが書く started.txt が現れたのを見てから止める。
 */
test('確かめの最中に止めた送り口は、aborted で終える', async () => {
  const fake = await startFakeServer({
    kind: 'steps',
    calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x\n' } }],
    then: '作りました。',
  });
  const root = await tempDir('aas-send-stop-root-');
  const SLOW = `node -e "require('fs').writeFileSync('started.txt','1'); setTimeout(() => {}, 60000)"`;
  const session = await Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'], runtime: { kind: 'none' },
    agent: { root, approval: 'auto', maxTurns: 4, verify: { command: SLOW, baseline: false } },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  try {
    let settled: { reason?: string } | undefined;
    const draining = (async () => {
      for await (const ev of session.send('a.txt を作って')) if (ev.type === 'settled') settled = ev as { reason?: string };
    })();
    let started = false;
    for (let i = 0; i < 2_000 && !started; i += 1) {
      started = await stat(join(root, 'started.txt')).then(() => true, () => false);
      if (!started) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(started, '確かめのコマンドが始まらない');
    session.abort();
    await draining;
    assert.equal(settled?.reason, 'aborted', `確かめの最中に止めたのに ${settled?.reason} で終えた（次の段へ進む）`);
  } finally {
    await session.close();
    await fake.close();
  }
});
