/**
 * 順番待ちから取り出した依頼を、始められなかったときに黙って落とさない。
 *
 * 取り出してから走り出すまで（会話の載せ替え・組み立て）に落ちると、取り出した依頼ごと消えていた。
 * ここでは、載せ替える会話の記録を読めなくして（ファイルの場所にフォルダを置く。権限に頼らない）落とし、
 * 依頼が順番待ちに戻ること・読めるようになれば流れることを見る。
 *
 * 形: A を本体で長く走らせ、その間に B を横で走らせ、B へ二つ目を送って積む。B が終わってから A が終わるまでの間に
 * B の記録を読めなくする。A の終わりで二つ目を取り出すと、B を本体へ載せられずに落ちる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rename, rmdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-queue-putback-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('始められなかった依頼は順番待ちに戻り、読めるようになれば流れる', async () => {
  // A は長く、B は短く返す（B が終わってから A が終わるまでに、B の記録を読めなくする間を作る）
  const fake = await startFakeServer({ kind: 'echo', delayFor: (asked: string) => (asked.includes('A の依頼') ? 2500 : 200) });
  const server = new UiServer({
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
  const base = (await server.start()).replace(/\/$/, '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (r: Response): Promise<any> => r.json();
  const post = (p: string, body?: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const seen: { type: string; level?: string; text?: string; waiting?: number }[] = [];
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
  const fileOf = (id: string) => join(dir, 'state', 'conversations', `${id}.jsonl`);
  try {
    await new Promise((r) => setTimeout(r, 100));
    const a = await json(await post('/api/send', { text: 'A の依頼' }));
    assert.equal(a.accepted, true, JSON.stringify(a));
    await post('/api/conversations');
    const b = await json(await post('/api/send', { text: 'B の依頼' }));
    assert.equal(b.accepted, true, `B が横で走らない: ${JSON.stringify(b)}`);
    const idB = b.conversationId as string;
    await post('/api/conversations/select', { id: idB });
    const b2 = await json(await post('/api/send', { text: 'B の二つ目' }));
    assert.equal(typeof b2.queued, 'number', `B の二つ目が積まれない: ${JSON.stringify(b2)}`);

    // B（横）が終わって記録が書けるまで待ち、読めなくする（A はまだ走っている）
    await until(async () => {
      const c = await json(await fetch(`${base}/api/conversations`));
      return !(c.runningAll as string[]).includes(idB);
    }, 'B が終わる', { timeoutMs: 10_000, everyMs: 50 });
    await rename(fileOf(idB), `${fileOf(idB)}.away`);
    await mkdir(fileOf(idB));

    // A の終わりで二つ目を取り出し、載せ替えで落ちる → 順番待ちに戻る
    await until(async () => seen.some((e) => e.type === 'log' && e.text?.includes('順番待ちの依頼を始められませんでした')),
      '始められなかったと言う', { timeoutMs: 15_000, everyMs: 50 });
    const back = seen.filter((e) => e.type === 'queue').at(-1);
    assert.equal(back?.waiting, 1, `順番待ちに戻っていない: ${JSON.stringify(back)}`);

    // 読めるようにして、見回りで流す
    await rmdir(fileOf(idB));
    await rename(`${fileOf(idB)}.away`, fileOf(idB));
    const session = await server.session();
    await server.idleTick(session);
    await until(async () => {
      const m = await json(await fetch(`${base}/api/conversations/messages?id=${idB}`));
      return (m.messages as { role: string; content: string }[]).some((x) => x.role === 'user' && x.content.includes('B の二つ目'));
    }, '戻した依頼が流れる', { timeoutMs: 15_000, everyMs: 100 });
  } finally {
    ac.abort(); await stream;
    await server.stop();
    await fake.close();
  }
});
