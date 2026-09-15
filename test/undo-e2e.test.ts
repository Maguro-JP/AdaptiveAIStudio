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
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-undo-e2e-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** リンクを作れるか。作れない機械（Windows の一般権限）では、その分だけ飛ばす。 */
async function canLink(): Promise<boolean> {
  const d = await tempDir('aas-undo-ln-');
  await writeFile(join(d, 'a'), 'x');
  try { await symlink(join(d, 'a'), join(d, 'b')); return true; } catch { return false; }
}
const linkable = await canLink();

/**
 * 作業場を、**実体と違う綴りで**渡す。
 *
 * Windows では `%TEMP%` が `C:\Users\RUNNER~1\...`（8.3 の短い名前）で来るのに
 * realpath は `C:\Users\runneradmin\...` を返す。junction・ネットワークの割り当て・
 * OneDrive の付け替えでも同じ形になる。linux では symlink で同じ形が作れる。
 */
async function linkedRoot(): Promise<string> {
  const base = await tempDir('aas-undo-linkroot-');
  const real = join(base, 'real');
  const asRoot = join(base, 'asroot');
  await mkdir(real);
  await symlink(real, asRoot);
  return asRoot;
}

describe('直されたものを、押して戻せる', () => {
  /** 一連の流れ。渡す作業場の作り方だけを入れ替えて、二通りで見る。 */
  async function roundTrip(root: string): Promise<void> {
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
  }

  test('**書かせて、`/api/undo` で元に戻る**', async () => {
    await roundTrip(await tempDir('aas-undo-root-'));
  });

  /**
   * 作業場の綴りが実体と違うと、**戻すが何も戻さずに黙って終わっていた。**
   *
   * 控える道を実体の綴りで作っていたため、`../../../../../runneradmin/...` のような
   * 形になり、戻す側の `safeResolve` がそれを弾いていた。弾いたことは誰にも言わない
   * ので、押しても何も起きない。Windows の CI で見つけた（`src/agent/tools/paths.ts`）。
   */
  test('**綴りが実体と違う作業場でも、戻る**',
    { skip: linkable ? false : 'この機械ではリンクを作れない' },
    async () => {
      await roundTrip(await linkedRoot());
    });
});
