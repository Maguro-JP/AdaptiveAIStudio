/**
 * 動いている会話へ戻ったら、途中までが見える。
 *
 * 出来事は見ている会話のものしか描かないので、離れていた間の分は消える。
 * 戻ったとき（開き直したとき）に、本体が持っている「ここまで」を写す。
 * 写した分と、その後に流れてくる分を二度描かないよう、番号（seq）を添える。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-inflight-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
import { startFakeServer, type FakeServer } from './fake-server.ts';

let fake: FakeServer;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  // 一文字ずつ流す。途中で見に行けるように。
  fake = await startFakeServer({ kind: 'echo', delayMs: 200, trickleMs: 60 });
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
type InFlight = { asked: string; text: string; seq: number } | null;
const select = async (id: string) => json(await post('/api/conversations/select', { id })) as Promise<{ inFlight: InFlight; messages: unknown[] }>;

describe('動いている会話へ戻ったら、途中までが見える', () => {
  test('戻ったとき・開き直したときに「ここまで」が返り、終わったら消える。出来事には番号が付く', async () => {
    const seen: { type: string; conversationId?: string; seq?: number; event?: { type?: string } }[] = [];
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
    await until(() => seen.length > 0, '出来事の口が開く', { timeoutMs: 5000, everyMs: 20 }).catch(() => undefined);

    const a = await json(await post('/api/send', { text: 'A の依頼' }));
    assert.equal(a.accepted, true, JSON.stringify(a));
    const idA = a.conversationId as string;

    // 別の会話（トップ）へ離れて、A へ戻る。途中までが返る。
    assert.equal((await post('/api/conversations')).status, 200);
    const held: { got: InFlight } = { got: null };
    await until(async () => { held.got = (await select(idA)).inFlight; return !!held.got && held.got.text.length > 0; },
      'A の途中までが返る', { timeoutMs: 10_000, everyMs: 30 });
    const got = held.got!;
    assert.ok(got.asked.includes('A の依頼'), `頼んだ文が無い: ${JSON.stringify(got)}`);
    assert.ok('答え: A の依頼'.startsWith(got.text), `途中までが答えの頭ではない: ${JSON.stringify(got)}`);
    assert.equal(got.seq, [...got.text].length, '番号が流した文字の数と合わない');

    // 開き直したときの道（messages）でも同じものが返る。
    const reopened = await json(await get(`/api/conversations/messages?id=${idA}`));
    assert.ok(reopened.inFlight, '開き直したときに途中までが無い');
    assert.ok(reopened.inFlight.seq >= got.seq);

    // 終わったら消える。答えは会話に残る。
    await until(async () => (await json(await get(`/api/conversations/messages?id=${idA}`))).messages.length >= 2,
      'A が終わる', { timeoutMs: 15_000, everyMs: 50 });
    assert.equal((await select(idA)).inFlight, null, '終わったのに途中までが残っている');
    ac.abort(); await stream;

    // 流れた文字の出来事には、1 から順に番号が付いている。
    const seqs = seen.filter((e) => e.type === 'session' && e.event?.type === 'text' && e.conversationId === idA).map((e) => e.seq);
    assert.ok(seqs.length > 0, '文字の出来事が無い');
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `番号が順になっていない: ${JSON.stringify(seqs)}`);
  });
});
