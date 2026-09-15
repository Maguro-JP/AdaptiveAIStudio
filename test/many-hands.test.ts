/**
 * 手が一つでも、口は会話ごと。
 *
 * 動いている間は別の会話へ切り替えられず（「終わってから」と断っていた）、
 * 送ったものは見ている会話に関係なく一つの流れに積まれていた。
 * 見ている会話・本体に載っている会話・動いている会話を分け、動いている間も
 * 切り替えられ、別の会話への依頼も積めて、答えは頼んだ会話に残る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-hands-');
// この機械に残っている設定（~/.aas/aas.config.json）を読ませない。試験は自分のフォルダだけを見る。
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

import { startFakeServer, type FakeServer } from './fake-server.ts';
let fake: FakeServer;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  fake = await startFakeServer({ kind: 'echo', delayMs: 1200 });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const post = (p: string, body?: unknown) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const get = (p: string) => fetch(base + p);
const messagesOf = async (id: string) => (await json(await get(`/api/conversations/messages?id=${id}`))).messages as { role: string; content: string }[];

describe('動いている間も、別の会話が持てる', () => {
  test('A を送って動いている間に、トップへ戻って B を送り、A を見に戻れる。答えはそれぞれの会話に残る', async () => {
    // 出来事を集める（会話の名前が添えてあるか見る）。
    const seen: { type: string; conversationId?: string; event?: { type?: string } }[] = [];
    const ac = new AbortController();
    const stream = fetch(base + '/api/events', { signal: ac.signal }).then(async (r) => {
      const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/data: (.*)\n/g)) { try { seen.push(JSON.parse(m[1]!)); } catch { /* 途中 */ } }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));

    // A（トップから送る → 会話ができる）
    const ra = await post('/api/send', { text: 'A の依頼' });
    const a = await json(ra);
    assert.equal(a.accepted, true, `${ra.status} ${JSON.stringify(a)}`);
    assert.ok(a.conversationId, 'どの会話への依頼か言っていない');
    const idA = a.conversationId as string;

    // 動いている間に、トップへ戻れる（断られない）。
    const top = await post('/api/conversations');
    const topBody = await top.text();
    assert.equal(top.status, 200, topBody);
    assert.equal(JSON.parse(topBody).running, idA, '動いている会話を言っていない');

    // B を送ると、新しい会話に積まれる。
    const b = await json(await post('/api/send', { text: 'B の依頼' }));
    assert.equal(typeof b.queued, 'number', `積まれていない: ${JSON.stringify(b)}`);
    assert.ok(b.conversationId && b.conversationId !== idA, 'B が A と同じ会話になっている');
    const idB = b.conversationId as string;

    // 動いている間に A を見に戻れる。
    const sel = await post('/api/conversations/select', { id: idA });
    const selBody = await sel.text();
    assert.equal(sel.status, 200, selBody);

    // 両方が終わるまで。
    await until(async () => (await messagesOf(idA)).length >= 2 && (await messagesOf(idB)).length >= 2,
      '二つの会話に答えが残る', { timeoutMs: 30_000, everyMs: 100 });
    ac.abort(); await stream;

    const ma = await messagesOf(idA);
    const mb = await messagesOf(idB);
    assert.ok(ma.some((m) => m.role === 'assistant' && m.content.includes('A の依頼')), `A に A の答えが無い: ${JSON.stringify(ma)}`);
    assert.ok(mb.some((m) => m.role === 'assistant' && m.content.includes('B の依頼')), `B に B の答えが無い: ${JSON.stringify(mb)}`);
    assert.ok(!ma.some((m) => m.content.includes('B の依頼')), 'A に B が混ざっている');
    assert.ok(!mb.some((m) => m.content.includes('A の依頼')), 'B に A が混ざっている');

    // 出来事には、どの会話のものかが添えてある。
    const tagged = seen.filter((e) => e.type === 'session' && e.event?.type === 'settled').map((e) => e.conversationId);
    assert.deepEqual(tagged, [idA, idB], `終わりの出来事に会話の名前が無い／順が違う: ${JSON.stringify(tagged)}`);
  });
});
