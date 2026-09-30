/**
 * 作業中に作業場を変えても、作業が終われば、変えた作業場の本体に切り替わる。
 *
 * 作業中は本体を畳めないので、前の作業場で組んだ本体が残る。前は、作業が終わってもそのまま残り続け、
 * 手で書いた分は新しい作業場へ書くのに「戻す」の記録は前の作業場の本体に積んでいた。
 * 戻すと、前の作業場の同じ名前のファイルへ、新しい作業場の中身を書き込んでいた。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-root-busy-');
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
  await writeFile(join(rootA, 'note.txt'), 'A の中身\n');
  await writeFile(join(rootB, 'note.txt'), 'B の中身\n');
  // 答えるまで待たせて、作業中に作業場を変えられるようにする。
  fake = await startFakeServer({ kind: 'echo', delayMs: 300, trickleMs: 40 });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const call = (method: string, p: string, body?: unknown) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

describe('作業中に作業場を変えたとき', { timeout: 60_000 }, () => {
  test('作業が終われば、手で書いた分も「戻す」も、変えた作業場に当たる（前の作業場を書き換えない）', async () => {
    // 答えは頼んだ文をそのまま流すので、長くして走っている間を延ばす（遅い機械でも、変える前に終わらない）
    const sent = await json(await call('POST', '/api/send', { text: '長い依頼。'.repeat(20) }));
    assert.equal(sent.accepted, true, JSON.stringify(sent));
    const idA = sent.conversationId as string;
    // 走っている間（途中までが見える間）に作業場を変える。
    await until(async () => {
      const got = await json(await call('POST', '/api/conversations/select', { id: idA }));
      return !!got.inFlight && got.inFlight.text.length > 0;
    }, '依頼が走り出す', { timeoutMs: 10_000, everyMs: 20 });
    const changed = await json(await call('PUT', '/api/config', { workRoot: rootB }));
    assert.equal(changed.restartNeeded, true, `作業中なのに、その場で効いたことになっている: ${JSON.stringify(changed)}`);

    await until(async () => (await json(await fetch(`${base}/api/conversations/messages?id=${idA}`))).messages.length >= 2,
      '依頼が終わる', { timeoutMs: 15_000, everyMs: 50 });

    // 終わったら、本体は変えた作業場のもの（了解した警告の口は、生きている本体の作業場を返す）。
    await until(async () => (await json(await fetch(base + '/api/acks'))).root === rootB,
      '作業が終わっても、前の作業場の本体が残っている', { timeoutMs: 5_000, everyMs: 50 });

    // 手で書く。道は変えた作業場で解くので、B に書かれる。
    const put = await call('PUT', '/api/file', { path: 'note.txt', content: '手で直した\n' });
    assert.equal(put.status, 200, await put.text());
    assert.equal(await readFile(join(rootB, 'note.txt'), 'utf8'), '手で直した\n');

    // 戻すと、B が元に戻る。A には触らない。
    const list = (await json(await fetch(base + '/api/undo'))).list as { id: string; request?: string }[];
    const mine = list.find((e) => (e.request ?? '').includes('note.txt'));
    assert.ok(mine, `手で直した分が「戻す」の一覧に無い（前の作業場の一覧を見ている）: ${JSON.stringify(list)}`);
    const back = await call('POST', '/api/undo', { id: mine.id });
    assert.equal(back.status, 200, await back.text());
    assert.equal(await readFile(join(rootB, 'note.txt'), 'utf8'), 'B の中身\n', '変えた作業場が元に戻っていない');
    assert.equal(await readFile(join(rootA, 'note.txt'), 'utf8'), 'A の中身\n', '前の作業場のファイルを書き換えた');
  });
});
