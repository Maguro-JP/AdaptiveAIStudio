/**
 * **依頼のあいだだけ効くものを、入口ごとに倒さない。**
 *
 * 「この依頼のあいだは訊かない」は、送り口（send）の入口でだけ倒していた。
 * 段取り（plan）の入口では倒していなかったので、一度その押し場所を選んだあとに
 * 段取りを送ると、**札を一枚も出さずに全部の書き込みが通る。**段取りでも
 * ファイルは触る。
 *
 * 入口が増えるたびに倒し忘れが起きるので、依頼に通し番号を振って、
 * **番号が変わったら外れる**形にした。ここでは、どちらの入口でも番号が
 * 進むことを見る（進まない入口が在ると、そこが素通りの口になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-request-seq-');
const { Session } = await import('../src/core/session.ts');

async function opened() {
  const fake = await startFakeServer({ kind: 'stream', text: 'JSON ではない返事' });
  const root = await tempDir('aas-request-seq-root-');
  const session = await Session.create({
    providers: [{
      id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'],
    }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 1 },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  return { session, fake };
}

describe('依頼の通し番号', () => {
  test('**送り口でも段取りでも、番号が進む**', async () => {
    const { session, fake } = await opened();
    try {
      const first = session.requestSeq;

      for await (const _ of session.send('何か直して')) { /* 最後まで回す */ }
      const afterSend = session.requestSeq;
      assert.ok(afterSend > first, `送り口で番号が進んでいない（${first} → ${afterSend}）`);

      const seen: string[] = [];
      for await (const ev of session.plan('何か直して')) seen.push(ev.type);
      // 段取りが本当に走ったことを見る。断られて即座に返っていたら、番号が
      // 進まないのは当たり前で、この試験は何も見ていないことになる。
      assert.ok(seen.includes('planned'), `段取りが走っていない: ${seen.join(',')}`);
      const afterPlan = session.requestSeq;
      assert.ok(afterPlan > afterSend, `段取りで番号が進んでいない（${afterSend} → ${afterPlan}）`);
    } finally {
      await session.close();
      await fake.close();
    }
  });
});
