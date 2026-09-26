/**
 * 画面の中でファイルを開いて、直して、保存する。
 *
 * ここまでは、ファイルは指示を通してだけ触る作りだった。直したい一行の
 * ために依頼を書かせるのは、Cursor と並べて明らかに劣る。
 * 手で直したものも、モデルの直しと同じく戻り先に残り、差分として出る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = await tempDir('aas-editor-');
process.env.AAS_STATE_DIR = join(dir, 'state');

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const work = join(dir, 'work');
await mkdir(work, { recursive: true });
await writeFile(join(work, 'a.txt'), 'one\ntwo\n');
await writeFile(join(work, 'bin.dat'), Buffer.from([0x47, 0x49, 0x46, 0x00, 0x01, 0x02]));

let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { root: work } } as typeof DEFAULT_CONFIG, port: 0 });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const get = (p: string) => fetch(base + p);
const put = (body: unknown) => fetch(base + '/api/file', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('開く', () => {
  test('作業場の中の文字のファイルは、中身が返る', async () => {
    const r = await get('/api/file?path=a.txt');
    assert.equal(r.status, 200);
    const j = await json(r);
    assert.equal(j.content, 'one\ntwo\n');
    assert.equal(j.path, 'a.txt');
  });
  test('作業場の外は開けない', async () => {
    assert.equal((await get('/api/file?path=../a.txt')).status, 400);
    assert.equal((await get('/api/file?path=/etc/hostname')).status, 400);
  });
  test('無いものは 404', async () => {
    assert.equal((await get('/api/file?path=nope.txt')).status, 404);
  });
  test('文字でないものは開かない（壊すだけ）', async () => {
    assert.equal((await get('/api/file?path=bin.dat')).status, 415);
  });
});

describe('保存する', () => {
  test('書けて、戻り先に残り、差分が出る', async () => {
    const seen: unknown[] = [];
    const ac = new AbortController();
    const stream = fetch(base + '/api/events', { signal: ac.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/data: (.*)\n/g)) seen.push(JSON.parse(m[1]!));
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));

    const r = await put({ path: 'a.txt', content: 'one\nTWO\nthree\n' });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const j = JSON.parse(text);
    assert.equal(j.saved, true);
    assert.deepEqual({ added: j.added, removed: j.removed }, { added: 2, removed: 1 });
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');

    // 戻り先に残っている。
    const undo = await json(await get('/api/undo'));
    assert.ok(undo.list.some((u: { request: string; paths: string[] }) => u.request.includes('a.txt') && u.paths.includes('a.txt')),
      `戻り先に無い: ${JSON.stringify(undo.list)}`);

    // 差分の出来事が流れている（「変更したファイル」が拾う形）。
    await new Promise((r) => setTimeout(r, 200));
    ac.abort(); await stream;
    const diff = seen.find((e) => (e as { type?: string; event?: { type?: string } }).type === 'session'
      && (e as { event: { type?: string } }).event.type === 'diff') as { event: { path: string; diff: string } } | undefined;
    assert.ok(diff, `差分が流れていない: ${JSON.stringify(seen.map((e) => (e as { type: string }).type))}`);
    assert.equal(diff.event.path, 'a.txt');
    assert.match(diff.event.diff, /\+TWO/);
  });

  test('同じ中身なら、書かない（戻り先も増やさない）', async () => {
    const before = (await json(await get('/api/undo'))).list.length;
    const j = await json(await put({ path: 'a.txt', content: 'one\nTWO\nthree\n' }));
    assert.equal(j.saved, false);
    assert.equal((await json(await get('/api/undo'))).list.length, before);
  });

  test('作業場の外には書けない', async () => {
    assert.equal((await put({ path: '../x.txt', content: 'x' })).status, 400);
    assert.equal((await put({ path: 'a.txt' })).status, 400);
  });
});

describe('当てた変更を、塊ごと・行ごとに戻す', () => {
  const post = (p: string, body: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  test('差分の行を押すと、その行を含む書き換えの組を丸ごと戻す', async () => {
    // a.txt はいま one / TWO / three。差分（one/two → one/TWO/three）の +three を押す。
    // 組（-two / +TWO / +three）ごと戻るので one / two になる（片方だけ戻して両方が並ぶ姿を作らない）。
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const diff = unifiedDiff('a.txt', 'one\ntwo\n', 'one\nTWO\nthree\n');
    const { splitHunks } = await import('../src/agent/hunks.ts');
    const at = splitHunks(diff)[0]!.lines.indexOf('+three');
    assert.ok(at >= 0);
    const r = await post('/api/revert', { path: 'a.txt', diff, picks: [{ hunk: 0, lines: [at] }] });
    const j = await json(r);
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.reverted, true);
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'one\ntwo\n');
    // 戻したことも、戻り先に残る。
    const undo = await json(await get('/api/undo'));
    assert.ok(undo.list.some((u: { request: string }) => u.request.startsWith('戻した: a.txt')), JSON.stringify(undo.list));
  });
  test('その後に変わっていれば、壊さずに断る', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const stale = unifiedDiff('a.txt', 'one\ntwo\n', 'one\nTWO\nthree\n');
    const r = await post('/api/revert', { path: 'a.txt', diff: stale, picks: [{ hunk: 0 }] });
    assert.equal(r.status, 409);
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'one\ntwo\n');
  });
  test('材料が足りなければ 400', async () => {
    assert.equal((await post('/api/revert', { path: 'a.txt' })).status, 400);
  });
  test('前が utf8 で読めない中身だった差分は、当てずに断る（仮の一行がファイルに書かれる）', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const { opaqueLine } = await import('../src/agent/tools/fs.ts');
    const now = await readFile(join(work, 'a.txt'), 'utf8');
    const diff = unifiedDiff('a.txt', `${opaqueLine(13)}\n`, now);
    const r = await post('/api/revert', { path: 'a.txt', diff, picks: [{ hunk: 0 }] });
    assert.equal(r.status, 409);
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), now, '断ったのに書いている');
  });
});

describe('画面', () => {
  test('横の一覧のファイルは、エディタで開く（依頼に添えるのは @）', () => {
    const app = readFileSync(join(here, '../src/ui/web/app.js'), 'utf8');
    assert.ok(app.includes('openInEditor(entry.path)'), 'ファイルを押してもエディタで開かない');
    assert.ok(app.includes("openPanel(layout, 'editor')"), '出ていないときに出していない');
  });
  test('エディタは Ctrl+S で保存し、Tab で欄から抜けない', () => {
    const panels = readFileSync(join(here, '../src/ui/web/panels.js'), 'utf8');
    const ed = panels.slice(panels.indexOf('  editor(body, ctx) {'));
    assert.ok(/e\.key === 's'/.test(ed) && /preventDefault/.test(ed), 'Ctrl+S を受けていない');
    assert.ok(/e\.key === 'Tab'/.test(ed), 'Tab を字にしていない');
    assert.ok(ed.includes("'/api/file'"), '保存の口を叩いていない');
  });
});

/**
 * 画面で直している最中に、AI が同じファイルを書くことがある。
 *
 * そのとき、ファイルは AI の版・欄は人の版、と二つに割れる。保存は先に
 * 書いた方を**何も言わずに消していた**（人が保存すれば AI の直しが消える）。
 * 開いたときの stamp を持たせて、合わないなら断る。どちらを残すかは人が選ぶ。
 */
describe('黙って上書きさせない', () => {
  test('**開いたあとで変わっていたら、断る。中身は壊さない**', async () => {
    await writeFile(join(work, 'c.txt'), 'はじめ\n');
    const opened = await json(await get('/api/file?path=c.txt'));
    assert.ok(opened.stamp, '開いたときの stamp が返っていない');
    // ここで AI（や別の誰か）が書いた、という状況を作る。
    await writeFile(join(work, 'c.txt'), 'AI が書いた\n');
    const r = await put({ path: 'c.txt', content: '人が書いた\n', stamp: opened.stamp });
    assert.equal(r.status, 409);
    const j = await json(r);
    assert.equal(j.conflict, true);
    // 断るだけでなく、**いま在る中身も返す**（画面で並べて選べるように）。
    assert.equal(j.content, 'AI が書いた\n');
    assert.ok(j.stamp && j.stamp !== opened.stamp, '新しい stamp が返っていない');
    assert.equal(await readFile(join(work, 'c.txt'), 'utf8'), 'AI が書いた\n', '断ったのに書いている');
  });

  test('新しい stamp で出し直せば、保存できる', async () => {
    await writeFile(join(work, 'd.txt'), 'はじめ\n');
    const opened = await json(await get('/api/file?path=d.txt'));
    await writeFile(join(work, 'd.txt'), 'AI が書いた\n');
    const refused = await json(await put({ path: 'd.txt', content: '人が書いた\n', stamp: opened.stamp }));
    const r = await put({ path: 'd.txt', content: '人が書いた\n', stamp: refused.stamp });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(join(work, 'd.txt'), 'utf8'), '人が書いた\n');
  });

  test('変わっていなければ、stamp を送っても普通に保存できる（対）', async () => {
    await writeFile(join(work, 'e.txt'), 'はじめ\n');
    const opened = await json(await get('/api/file?path=e.txt'));
    const r = await put({ path: 'e.txt', content: 'なおした\n', stamp: opened.stamp });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(join(work, 'e.txt'), 'utf8'), 'なおした\n');
  });

  test('stamp を送らなければ、今までどおり保存する（古い画面を締め出さない）', async () => {
    await writeFile(join(work, 'f.txt'), 'はじめ\n');
    await get('/api/file?path=f.txt');
    await writeFile(join(work, 'f.txt'), 'AI が書いた\n');
    const r = await put({ path: 'f.txt', content: '人が書いた\n' });
    assert.equal(r.status, 200, await r.text());
  });

  /**
   * **書けたら、新しい stamp を返す。**
   *
   * 返していなかったので、画面は開いたときの stamp を持ったままになり、
   * **続けて二度目を保存すると断られていた**（「別の所で変わりました（AI の
   * 書き換えなど）」。嘘だし、直すたびに押し直させることになる）。
   * 画面を押して見つけた。ここは本体の返しだけを見る。
   */
  test('**保存できたら、次に使える stamp が返る**', async () => {
    await writeFile(join(work, 'g.txt'), 'はじめ\n');
    const opened = await json(await get('/api/file?path=g.txt'));
    const first = await json(await put({ path: 'g.txt', content: '一度目\n', stamp: opened.stamp }));
    assert.ok(first.stamp, `保存の返しに stamp が無い: ${JSON.stringify(first)}`);
    assert.notEqual(first.stamp, opened.stamp, '中身が変わったのに stamp が同じ');
    // 返ってきた stamp は、開き直したときのものと同じ。
    const again = await json(await get('/api/file?path=g.txt'));
    assert.equal(first.stamp, again.stamp, '保存の返しと、開き直したときで stamp が違う');
    // **続けて保存できる。**ここが落ちると、一度直したら押し直すまで保存できない。
    const second = await put({ path: 'g.txt', content: '二度目\n', stamp: first.stamp });
    assert.equal(second.status, 200, await second.text());
    assert.equal(await readFile(join(work, 'g.txt'), 'utf8'), '二度目\n');
  });

  test('中身が同じで保存したときも、stamp を返す（対）', async () => {
    await writeFile(join(work, 'h.txt'), 'おなじ\n');
    const opened = await json(await get('/api/file?path=h.txt'));
    const r = await json(await put({ path: 'h.txt', content: 'おなじ\n', stamp: opened.stamp }));
    assert.equal(r.saved, false, '書いていないのに書いたことになっている');
    assert.equal(r.stamp, opened.stamp, `stamp が返っていない: ${JSON.stringify(r)}`);
  });
});
