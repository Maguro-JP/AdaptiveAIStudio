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
import { stat, readFile, mkdir, writeFile, symlink, lstat } from 'node:fs/promises';
import { tempDir } from './tmp.ts';

const state = await tempDir('aas-new-state-');
/*
 * **作業場の一つ上まで、この試験だけのものにする。**
 *
 * 作業場を直に temp の下へ置くと、その一つ上は `/tmp`（みんなで使う所）になる。
 * この試験は「外へは作らせない」を、一つ上にファイルが無いことで見ているので、
 * **誰かが `/tmp/outside.txt` を置いた瞬間に落ちる。**実際にそうなった
 * （別の作業が同じ機械で走っていた）。作りは正しいのに落ちるので、原因を
 * こちらのコードに探すことになる。一つ上も自分のものにすれば、誰にも触られない。
 */
const outer = await tempDir('aas-new-outer-');
const work = join(outer, 'work');
await mkdir(work, { recursive: true });
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

/**
 * 画面からは、リンク越しに書かない（AI の write_file・edit_file と同じ守り）。
 *
 * 保存はリンクを辿って実体に書き、戻り先にはリンクの名前で残していたので、「戻す」を押すとリンクが普通のファイルに変わり、
 * 実体は直したまま残った。切れたリンクなら、辿った先の作業場の外にファイルを作っていた。
 * Windows では git の既定でリンクが展開されず、リンクを作るのにも権限が要るので飛ばす。
 */
describe('リンク越しには書かない', { skip: process.platform === 'win32' }, () => {
  test('作業場の中を指すリンクへの保存は断り、実体もリンクも変えない', async () => {
    await writeFile(join(work, 'real.txt'), 'もとの中身\n');
    await symlink('real.txt', join(work, 'alias.txt'));
    const r = await post('/api/file', { path: 'alias.txt', content: '書き換え\n' }, 'PUT');
    const body = await r.json() as { error?: string };
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(body.error ?? '', /リンク/);
    assert.equal(await readFile(join(work, 'real.txt'), 'utf8'), 'もとの中身\n');
    assert.equal((await lstat(join(work, 'alias.txt'))).isSymbolicLink(), true);
  });

  test('差分の戻しも、リンクの名前では書かない', async () => {
    await writeFile(join(work, 'real2.txt'), 'one\ntwo\nthree\n');
    await symlink('real2.txt', join(work, 'alias2.txt'));
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const diff = unifiedDiff('alias2.txt', 'one\ntwo\n', 'one\ntwo\nthree\n');
    const r = await post('/api/revert', { path: 'alias2.txt', diff, picks: [{ hunk: 0 }] });
    assert.equal(r.status, 400, await r.text());
    assert.equal(await readFile(join(work, 'real2.txt'), 'utf8'), 'one\ntwo\nthree\n');
    assert.equal((await lstat(join(work, 'alias2.txt'))).isSymbolicLink(), true);
  });

  test('途中のフォルダがリンク（中を指す）なら、今までどおり保存でき、戻せば実体が戻る', async () => {
    await mkdir(join(work, 'realdir'), { recursive: true });
    await writeFile(join(work, 'realdir', 'f.txt'), 'まえ\n');
    await symlink('realdir', join(work, 'dirlink'));
    const r = await post('/api/file', { path: 'dirlink/f.txt', content: 'あと\n' }, 'PUT');
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(join(work, 'realdir', 'f.txt'), 'utf8'), 'あと\n');
    const { list } = await (await fetch(`${base}/api/undo`)).json() as { list: { id: string; paths: string[] }[] };
    const point = list.find((p) => p.paths.includes('dirlink/f.txt'));
    assert.ok(point, `戻り先に無い: ${JSON.stringify(list)}`);
    const u = await post('/api/undo', { id: point.id });
    assert.equal(u.status, 200, await u.text());
    assert.equal(await readFile(join(work, 'realdir', 'f.txt'), 'utf8'), 'まえ\n');
    assert.equal((await lstat(join(work, 'dirlink'))).isSymbolicLink(), true);
  });

  test('外を指す切れたリンクへの保存・作成は断り、外にファイルを作らない', async () => {
    await symlink(join(outer, 'dangling-a.txt'), join(work, 'dangle-a'));
    await symlink(join(outer, 'dangling-b.txt'), join(work, 'dangle-b'));
    const saved = await post('/api/file', { path: 'dangle-a', content: 'x' }, 'PUT');
    assert.equal(saved.status, 400, await saved.text());
    const made = await post('/api/files/new', { path: 'dangle-b', kind: 'file' });
    assert.equal(made.status, 400, await made.text());
    assert.equal(await exists(join(outer, 'dangling-a.txt')), false, '保存で外に作った');
    assert.equal(await exists(join(outer, 'dangling-b.txt')), false, '作成で外に作った');
  });
});

/**
 * 作業場を変えたあと、前の場所で訊かれても赤い字を出さない。
 *
 * 画面は開いている場所（`filesAt`）を持っている。作業場を変えるとその道は
 * 新しい作業場の外になるので、ここで 400 を返していた。画面には赤い字が出て、
 * 一覧は前のまま。**変えたのに変わっていないように見える。**
 * 根の一覧を出すだけなので、外を見せることにはならない。
 */
describe('前の作業場の中の道で訊かれたら、根を出す', () => {
  test('**外を指す道でも、根の一覧を 200 で返す**', async () => {
    await mkdir(join(work, 'inside'), { recursive: true });
    const r = await fetch(`${base}/api/files?path=..%2F..%2Fetc`);
    const body = await r.json() as { root: string; path: string; entries: { name: string }[] };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.path, '', '外の道をそのまま名乗っている');
    // **外の中身を出していないこと。**根の中にあるものだけ。
    assert.ok(body.entries.some((e) => e.name === 'inside'), JSON.stringify(body.entries));
    assert.ok(!body.entries.some((e) => e.name === 'passwd'), '外を出している');
  });

  test('根で訊けば、これまでどおり根の一覧（対）', async () => {
    const r = await fetch(`${base}/api/files?path=`);
    const body = await r.json() as { path: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.path, '');
  });
});
