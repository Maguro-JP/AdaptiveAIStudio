/**
 * 横の一覧から、ファイル・フォルダを作れる。
 *
 * 作る道が無かった。エディタで新しい名前を保存しても「作業場の外には書けません」と
 * 断られ（まだ無い道は実体で比べられないため）、画面からは一つも作れなかった。
 * 作ったファイルは戻り先（undo）に「元々無かった」と控え、戻せば消える。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';

const state = await tempDir('aas-new-state-');
const work = await tempDir('aas-new-work-');
process.env.AAS_STATE_DIR = state;
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, root: work } } as typeof DEFAULT_CONFIG, port: 0 });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

const post = (path: string, body: unknown, method = 'POST') => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const exists = (p: string) => stat(p).then(() => true, () => false);
const listed = async (at = ''): Promise<string[]> => {
  const j = await (await fetch(`${base}/api/files?path=${encodeURIComponent(at)}`)).json() as { entries: { name: string }[] };
  return j.entries.map((e) => e.name);
};

describe('横の一覧から作る', () => {
  test('ファイルを作ると、空で置かれ、一覧に出て、戻せば消える', async () => {
    const r = await post('/api/files/new', { path: 'memo.txt', kind: 'file' });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(join(work, 'memo.txt'), 'utf8'), '');
    assert.ok((await listed()).includes('memo.txt'), '一覧に出ない');
    // 戻り先に「元々無かった」と控えてある。戻せば消える。
    const { list } = await (await fetch(`${base}/api/undo`)).json() as { list: { id: string; request: string; paths: string[] }[] };
    const point = list.find((p) => p.paths.includes('memo.txt'));
    assert.ok(point, `戻り先に無い: ${JSON.stringify(list)}`);
    assert.match(point.request, /作った/);
    const u = await post('/api/undo', { id: point.id });
    assert.equal(u.status, 200, await u.text());
    assert.equal(await exists(join(work, 'memo.txt')), false, '戻しても残っている');
  });

  test('無い階層の中にも作れる（フォルダごと）', async () => {
    const r = await post('/api/files/new', { path: 'docs/notes/todo.md', kind: 'file' });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await exists(join(work, 'docs', 'notes', 'todo.md')), true);
  });

  test('フォルダを作る', async () => {
    const r = await post('/api/files/new', { path: 'src/new-dir', kind: 'dir' });
    assert.equal(r.status, 200, await r.text());
    assert.equal((await stat(join(work, 'src', 'new-dir'))).isDirectory(), true);
    assert.ok((await listed('src')).includes('new-dir'));
  });

  test('既にあるものは作らない（上書きしない）', async () => {
    await writeFile(join(work, 'keep.txt'), '大事', 'utf8');
    const r = await post('/api/files/new', { path: 'keep.txt', kind: 'file' });
    assert.equal(r.status, 409);
    assert.equal(await readFile(join(work, 'keep.txt'), 'utf8'), '大事', '中身が消えた');
  });

  test('作業場の外・絶対の道・おかしな名前は断る', async () => {
    for (const path of ['../outside.txt', join(work, '..', 'abs.txt'), 'a/../../b.txt', '', 'x/./y', 'x//y']) {
      const r = await post('/api/files/new', { path, kind: 'file' });
      assert.ok(r.status === 400, `${JSON.stringify(path)} が ${r.status} で通った`);
    }
    assert.equal(await exists(join(work, '..', 'outside.txt')), false);
    const bad = await post('/api/files/new', { path: 'z.txt', kind: 'symlink' });
    assert.equal(bad.status, 400);
  });

  test('**エディタから新しい名前で保存しても、作業場の外と嘘を言わない**', async () => {
    // 前は 400「作業場の外には書けません」だった（まだ無い道は実体で比べられない）。
    await mkdir(join(work, 'sub'), { recursive: true });
    const r = await post('/api/file', { path: 'sub/brand-new.txt', content: 'はじめて' }, 'PUT');
    const body = await r.json() as { saved?: boolean; error?: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.saved, true);
    assert.equal(await readFile(join(work, 'sub', 'brand-new.txt'), 'utf8'), 'はじめて');
    // 外は変わらず断る（対）。
    const out = await post('/api/file', { path: '../escape.txt', content: 'x' }, 'PUT');
    assert.equal(out.status, 400);
    assert.equal(await exists(join(work, '..', 'escape.txt')), false);
  });
});
