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

  /** この試験だけの作業場と本体。戻り先の中身と、配られるものを見る。 */
  async function place() {
    const root = await tempDir('aas-undo-said-');
    const original = 'export const add = (a, b) => a + b;\n';
    await writeFile(join(root, 'math.js'), original, 'utf8');
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
    const points = async () => (await (await fetch(`${base}/api/undo`)).json() as {
      list: { id: string; request: string; paths: string[] }[];
    }).list;
    return { root, base, original, points, stop: async () => { await server.stop(); await fake.close(); } };
  }

  /**
   * **戻り先の名前は、利用者が打った分だけ。**
   *
   * 依頼にはこちらが差し込んだものが前に付く（いま開いている所・添付の中身）。
   * 名前は依頼の一行目から取っていたので、横の一覧に
   * 「【いま開いているファイル】a.ts（3 行目）」と出て、**どの依頼を戻すのか
   * 人が選べなかった**（画面を押して見つけた）。
   */
  test('**戻り先の名前に、差し込んだ塊が出ない**', async () => {
    const { base, points, stop } = await place();
    try {
      const sent = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: '引き算にして',
          editor: { path: 'math.js', line: 1, selection: 'a + b', selectionFrom: 1, selectionTo: 1 },
        }),
      });
      assert.equal(sent.status, 202, await sent.text());
      await until(async () => (await points()).length > 0, '戻り先ができる', { timeoutMs: 40_000 });
      const list = await points();
      assert.equal(list[0]!.request, '引き算にして', `差し込んだ塊が名前になっている: ${list[0]!.request}`);
    } finally { await stop(); }
  });

  /**
   * **名前が空の戻り先を作らない。**
   *
   * 打った分だけを名前にしたので、**添付だけを送った回**（打った分が空）で
   * 名前が空になり、横の一覧に何も書かれていない行が並ぶ。どれを戻すのか選べない。
   */
  test('**添付だけを送っても、戻り先に名前が付く**', async () => {
    const { base, points, stop } = await place();
    try {
      // **この試験で増えた分だけを見る。**戻り先は保存先ごと（`AAS_STATE_DIR`）に
      // 溜まるので、同じファイルの前の試験が残した分も一覧に並ぶ。
      const before = new Set((await points()).map((x) => x.id));
      const put = await fetch(`${base}/api/attach?name=note.txt`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'a + b を引き算にしてください\n',
      });
      // 本文は一度しか読めない。先に読んでから、両方に使う。
      const putBody = await put.text();
      assert.equal(put.status, 200, putBody);
      const item = JSON.parse(putBody) as { id: string };
      const sent = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '', attachments: [item.id] }),
      });
      assert.equal(sent.status, 202, await sent.text());
      await until(async () => (await points()).some((x) => !before.has(x.id)), '戻り先ができる', { timeoutMs: 40_000 });
      const fresh = (await points()).find((x) => !before.has(x.id))!;
      assert.ok(fresh.request.trim().length > 0, `戻り先の名前が空になっている: ${JSON.stringify(fresh)}`);
    } finally { await stop(); }
  });

  /**
   * **戻したことを、開いている画面へ配る。**
   *
   * 配っていたのは一覧の作り直しだけだったので、開いているエディタは
   * **戻す前の中身のまま**「保存してあります」と出していた（押して実測）。
   * 書き込んだときと同じ差分を配れば、エディタは読み直す。
   */
  test('**戻すと、書き換えたときと同じ差分が配られる**', async () => {
    const { base, original, points, stop } = await place();
    const events: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    try {
      const res = await fetch(`${base}/api/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      void (async () => {
        let buf = '';
        try {
          for (;;) {
            const got = await reader.read();
            if (got.done) break;
            buf += dec.decode(got.value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n\n')) !== -1) {
              const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* 注釈 */ }
              }
            }
          }
        } catch { /* 読むのをやめた */ }
      })();

      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '引き算にして' }),
      });
      await until(async () => (await points()).length > 0, '戻り先ができる', { timeoutMs: 40_000 });
      // 動いている最中は戻せない（本体が断る）。終わったことを見てから押す。
      await until(() => {
        const last = [...events].reverse().find((e) => e.type === 'busy');
        return last !== undefined && last.busy === false;
      }, '1 ターンが終わる', { timeoutMs: 40_000 });
      const list = await points();
      events.length = 0;
      const back = await fetch(`${base}/api/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: list[0]!.id }),
      });
      assert.equal(back.status, 200, await back.text());

      await until(() => events.some((e) => {
        const v = (e as { event?: { type?: string; path?: string } }).event;
        return e.type === 'session' && v?.type === 'diff' && v.path === 'math.js';
      }), '戻したことが配られる', { timeoutMs: 20_000 });
      const sent = events.find((e) => (e as { event?: { type?: string } }).event?.type === 'diff')!;
      const v = (sent as { event: { diff: string; added: number; removed: number } }).event;
      assert.match(v.diff, /a \+ b/, `戻した後の中身が差分に出ていない: ${v.diff}`);
      assert.ok(v.added > 0 && v.removed > 0, `何行戻したのかが出ていない: +${v.added} -${v.removed}`);
    } finally {
      ac.abort();
      await stop();
    }
    assert.ok(original.includes('a + b'));
  });
});
