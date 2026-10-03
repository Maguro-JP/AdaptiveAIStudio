/**
 * 本体を畳むときは、古い本体の保存が終わってから新しい本体を組む。
 *
 * 畳むときは本体を先に外してから close（記憶・自律の保存を含む）を待つ。その間に新しい本体を組むと、
 * 新しい本体が記憶を読んだ後で、古い本体の保存が上書きする（新しい本体で忘れたものが戻る）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-retire-order-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
process.env.AAS_CONFIG = join(dir, 'aas.config.json');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
import { startFakeServer, type FakeServer } from './fake-server.ts';

const rootA = join(dir, 'a');
const rootB = join(dir, 'b');
let fake: FakeServer;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  fake = await startFakeServer({ kind: 'echo' });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: rootA, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

describe('本体を畳む順', { timeout: 30_000 }, () => {
  test('古い本体の close が終わるまで、新しい本体を組まない', async () => {
    const live = await server.session();
    // 古い本体の close を、こちらが開けるまで止めておく。
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let entered = false;
    let closed = false;
    const original = live.close.bind(live);
    live.close = async () => { entered = true; await gate; await original(); closed = true; };

    // 作業場を変える。手が空いているので、その場で古い本体を畳みにいく。
    const put = fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot: rootB }),
    });
    await until(() => entered, '古い本体を畳み始める', { timeoutMs: 10_000, everyMs: 10 });

    // 畳んでいる最中に、新しい本体を頼む。
    let gotNext = false;
    const next = server.session().then((s) => { gotNext = true; return s; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(gotNext, false, '古い本体の保存が終わる前に、新しい本体を組んでいる');

    open();
    const fresh = await next;
    assert.equal(closed, true, '古い本体を閉じ終える前に、新しい本体を返している');
    assert.notEqual(fresh, live);
    assert.equal((await put).status, 200);
  });
});
