/**
 * 直されたものを、押して戻せる。
 *
 * **手元の小さいモデルは、間違った直しを当てる。**そのとき利用者にできることが
 * 「自分で書き戻す」しか無いなら、任せられない。何を頼むにも身構えることになる。
 *
 * ここでは**本物の書き込みの道**（道具 → `commit()` → 控え）を通してから、
 * 画面が押すのと同じ道（`/api/undo`）で戻るところまで見る。控える所を道具の外に
 * 置くと、通らない書き込みができて戻せなくなるので、単体ではなく端から端で見る。
 *
 * 置き場は**この試験だけのもの**にする。他と分け合うと、前の試験が残した
 * 会話ややり残しが混ざって、走らせる順で結果が変わる（実際にそうなった）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-undo-e2e-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('直されたものを、押して戻せる', () => {
  test('**書かせて、`/api/undo` で元に戻る**', async () => {
    const root = await tempDir('aas-undo-root-');
    const original = 'export const add = (a, b) => a + b;\n';
    await writeFile(join(root, 'math.js'), original, 'utf8');

    // **読んでから書く。**規則がその並びを求めるので、道具も順に呼ぶ。
    const fake = await startFakeServer({
      kind: 'steps',
      calls: [
        { name: 'read_file', args: { path: 'math.js' } },
        { name: 'edit_file', args: { path: 'math.js', find: 'a + b', replace: 'a - b' } },
      ],
      then: '直しました',
    });
    const server = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        runtime: { kind: 'ollama' },
        agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, approval: 'auto', root },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const sent = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '引き算にして' }),
      });
      assert.equal(sent.status, 202, await sent.text());

      await until(async () => (await readFile(join(root, 'math.js'), 'utf8')).includes('a - b'),
        'ファイルが書き換わる', { timeoutMs: 40_000 });
      // 戻り先は一往復の終わりに残る。書けた時点ではまだ無い。
      await until(async () => {
        const got = await (await fetch(`${base}/api/undo`)).json() as { list?: unknown[] };
        return (got.list ?? []).length > 0;
      }, '戻り先ができる', { timeoutMs: 40_000 });

      const { list } = await (await fetch(`${base}/api/undo`)).json() as {
        list: { id: string; request: string; paths: string[] }[];
      };
      assert.equal(list.length, 1, JSON.stringify(list));
      assert.deepEqual(list[0]!.paths, ['math.js']);
      assert.match(list[0]!.request, /引き算にして/, '何を頼んだときの直しかが分からない');

      const back = await fetch(`${base}/api/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: list[0]!.id }),
      });
      assert.equal(back.status, 200, await back.text());
      assert.equal(await readFile(join(root, 'math.js'), 'utf8'), original, '戻っていない');

      const after = await (await fetch(`${base}/api/undo`)).json() as { list: unknown[] };
      assert.equal(after.list.length, 0, '戻したのに残っている');
    } finally { await server.stop(); await fake.close(); }
  });
});
