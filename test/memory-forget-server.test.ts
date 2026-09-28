/**
 * 画面の本体が、忘れて戻せる覚えを `/api/state` の `memoryForgotten` で渡す。
 *
 * 画面が最後の一件しか持たなかったので、続けて二つ忘れると一つ目を戻せず、パネルを開き直すと戻す口ごと消えた。
 * 戻せる分は本体が持っているので、本体から渡す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-forget-srv-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { Memory } = await import('../src/memory/memory.ts');

test('**続けて二つ忘れても、両方を新しい順に渡し、どちらからでも戻せる**', async () => {
  await mkdir(join(dir, 'state'), { recursive: true });
  const seed = new Memory(join(dir, 'state', 'memory.jsonl'));
  await seed.load();
  const a = seed.remember({ kind: 'fact', title: '一つ目の覚え', now: 1000 }).entry.id;
  const b = seed.remember({ kind: 'decision', title: '二つ目の覚え', now: 2000 }).entry.id;
  await seed.save();

  const fake = await startFakeServer({ kind: 'echo' });
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'ollama' },
    agent: { root: dir, approval: 'auto' },
    initiative: { enabled: false },
  } as typeof DEFAULT_CONFIG;
  const server = new UiServer({ port: 0, config });
  const base = (await server.start()).replace(/\/$/, '');
  type State = { memory: { id: string }[]; memoryForgotten: { id: string; title: string; kind: string; at: number }[] };
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as State;
  const forget = (id: string) => fetch(`${base}/api/memory?id=${id}`, { method: 'DELETE' });
  try {
    // 記憶は、セッションを作ってから触れる（作る前は 409）
    assert.deepEqual((await state()).memoryForgotten, []);
    await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'こんにちは' }) });
    await until(async () => (await forget('m-none')).status === 404, 'セッションができる', { timeoutMs: 10000, everyMs: 50 });

    assert.equal((await forget(a)).status, 200);
    assert.equal((await forget(b)).status, 200);
    const after = await state();
    assert.deepEqual(after.memoryForgotten.map((x) => [x.id, x.title, x.kind]), [[b, '二つ目の覚え', 'decision'], [a, '一つ目の覚え', 'fact']]);
    assert.deepEqual(Object.keys(after.memoryForgotten[0]!).sort(), ['at', 'id', 'kind', 'title'], '中身まで渡している');

    // 前に忘れた方（一つ目）を戻す
    const r = await fetch(`${base}/api/memory/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a }),
    });
    assert.equal(r.status, 200);
    const back = await state();
    assert.deepEqual(back.memoryForgotten.map((x) => x.id), [b]);
    assert.ok(back.memory.some((x) => x.id === a), '戻した覚えが一覧に無い');
    assert.ok(!back.memory.some((x) => x.id === b));
  } finally {
    await server.stop();
    await fake.close();
  }
});
