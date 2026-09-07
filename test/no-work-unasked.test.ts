/**
 * 頼まれるまで、何も起こさない。
 *
 * 画面を開くと、横の一覧が提案・戻せるもの・新しい版を読みに行く。
 * ここが `session()` を呼んでいた。呼ぶと **`Session.create` が走り、
 * モデルの一覧を取り・MCP の相手を起こし・先読みを始め・記憶を読み込む。**
 *
 * 利用者は画面を開いただけで、何も頼んでいない。それなのに、MCP の相手が
 * 立ち上がらなければ 1 台につき最大 20 秒、その間このやりとりを受ける
 * 入口が全部止まる。実測で `/api/proposals` が **10023 ms** かかった
 * （立ち上がるが黙っている相手を 1 台置いただけ）。
 *
 * ## 時間では見ない
 *
 * 「速いこと」をテストにすると、走らせる機械で結果が変わる。
 * **跡が残るかで見る。**MCP の相手に、起きたらファイルを一つ置かせる。
 * 読むだけの入口を叩いてもそれが無ければ、起こしていない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-unasked-state-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let server: InstanceType<typeof UiServer>;
let base = '';
let mark = '';

const woke = async (): Promise<boolean> => access(mark).then(() => true, () => false);

before(async () => {
  const dir = await tempDir('aas-unasked-');
  await mkdir(dir, { recursive: true });
  mark = join(dir, 'おきた.txt');
  // 起きたらしるしを置いて、あとは黙っている相手。
  const mute = join(dir, 'mute.mjs');
  await writeFile(mute,
    `import { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(mark)}, 'おきました');\n`
    + 'setInterval(() => {}, 1000);\n', 'utf8');

  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{
        id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
        locality: 'local', models: ['m'], enabled: true,
      }],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto', verify: { enabled: false } },
      initiative: { enabled: false },
      // 待つ時間は短くしておく。ここで見たいのは「起こしたかどうか」で、速さではない。
      mcp: { servers: { だんまり: { command: process.execPath, args: [mute], startupTimeoutMs: 500 } } },
    } as never,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

describe('画面を開いただけでは、何も起こさない', () => {
  test('**開いた時点では、まだ誰も起きていない**', async () => {
    assert.equal(await woke(), false, '立ち上げただけで、外の相手を起こしている');
  });

  /*
   * ここが本題。画面が開いた直後に読む入口を、順に叩く。
   * どれもファイルから読めるもので、モデルも外の相手も要らない。
   */
  for (const path of ['/api/info', '/api/models', '/api/conversations',
    '/api/proposals', '/api/undo', '/api/update']) {
    test(`${path} は、外の相手を起こさない`, async () => {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, `${path} が ${r.status}`);
      assert.equal(await woke(), false,
        `${path} を読んだだけで、外の相手を起こしている（頼まれていない）`);
    });
  }

  test('**中身は、ちゃんと返っている**（対）', async () => {
    // 起こさないために、空を返しているのではない。
    const body = await fetch(`${base}/api/proposals`).then((x) => x.json()) as {
      open?: unknown[]; duties?: unknown[]; idle?: unknown;
    };
    assert.ok(Array.isArray(body.open), '提案の一覧が返っていない');
    assert.ok(Array.isArray(body.duties), '当番が返っていない');
    assert.ok(body.idle, '暇の配分が返っていない');
  });

  test('頼まれたら、そこで起こす（対）', async () => {
    /*
     * 何も起こさないのが正しいのではない。**頼まれるまで**起こさないのが正しい。
     *
     * 送りは、モデルが居ないとセッションを組む手前で断るので、ここでは使えない
     * （それはそれで正しい）。戻す操作は、実際に作業場を触るので組む。
     */
    const r = await fetch(`${base}/api/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'u-ない' }),
    });
    assert.ok([200, 404, 409].includes(r.status), `思わぬ返事: ${r.status}`);
    assert.equal(await woke(), true, '頼まれたのに、外の相手を起こしていない');
  });
});
