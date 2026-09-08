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
