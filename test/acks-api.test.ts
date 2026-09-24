/**
 * 画面の了解の口（`/api/acks`）。セッションを作らずに、作業場ごとに読み書きできる。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

// 記録の保存先を、試験専用の場所へ移してから読み込む。
const dir = await tempDir('aas-acks-api-');
process.env.AAS_STATE_DIR = dir;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let base = '';
let server: InstanceType<typeof UiServer>;
const work = await tempDir('aas-acks-work-');

before(async () => {
  server = new UiServer({
    config: { ...DEFAULT_CONFIG, agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, root: work } } as typeof DEFAULT_CONFIG,
    port: 0,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

const call = (method: string, body?: unknown) => fetch(`${base}/api/acks`, {
  method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
});

describe('/api/acks', () => {
  test('了解して、一覧に出て、また出すで消える', async () => {
    let r = await call('GET');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json() as { acks: unknown[] }).acks, []);

    r = await call('POST', { id: 'outside-uncomparable' });
    assert.equal(r.status, 200);
    const listed = await (await call('GET')).json() as { root: string; acks: Array<{ id: string; text: string; at: string }> };
    assert.equal(listed.acks.length, 1);
    assert.equal(listed.acks[0]!.id, 'outside-uncomparable');
    assert.match(listed.acks[0]!.text, /比べられない/);
    // 本体と同じファイルに入っている（CLI の /ack と同じ記憶）。
    const raw = JSON.parse(await readFile(join(dir, 'acks.json'), 'utf8')) as { acks: Array<{ root: string }> };
    assert.equal(raw.acks[0]!.root, listed.root);

    r = await call('DELETE', { id: 'outside-uncomparable' });
    assert.equal(r.status, 200);
    assert.deepEqual((await (await call('GET')).json() as { acks: unknown[] }).acks, []);
  });

  test('知らない名前は 400', async () => {
    const r = await call('POST', { id: 'nope' });
    assert.equal(r.status, 400);
  });
});
