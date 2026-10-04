/**
 * 画面の手書きの不具合（20 回目の調査）。
 *
 * - 守る道（`.git` の中・`.env` など）は画面からも守る。`.git` の中は断り、ほかは確かめてから書く
 * - 書き込みは隣の一時ファイルから置き換える（途中で落ちても元の中身を壊さない・ハードリンクの先を書き換えない）
 * - 「消されたので作り直す」は、その間に別の所で作られた中身を上書きしない
 * - 別の作業場で出た差分は、いまの作業場に当てない
 * - Windows の予約された名前を断る
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, link, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-hand-gaps-state-');
// 作業場を変える口は設定ファイルへ書く。この試験の中の設定を使う（指さないと、利用者のデータの保存先の設定を書き換える）
process.env.AAS_CONFIG = join(await tempDir('aas-hand-gaps-config-'), 'aas.config.json');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const work = join(await tempDir('aas-hand-gaps-'), 'work');
await mkdir(work, { recursive: true });

let server: InstanceType<typeof UiServer>;
let base = '';
before(async () => {
  server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { root: work } } as typeof DEFAULT_CONFIG, port: 0 });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

const send = (method: string, p: string, body: unknown) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('守る道', () => {
  test('**.git の中は、画面の保存でも新しいファイルでも書かない**（確かめても書かない）', async () => {
    await mkdir(join(work, '.git', 'hooks'), { recursive: true });
    const made = await send('POST', '/api/files/new', { path: '.git/hooks/pre-commit', kind: 'file', confirmProtected: true });
    assert.equal(made.status, 403, await made.text());
    const saved = await send('PUT', '/api/file', { path: 'sub/.git/config', content: '[core]\n', confirmProtected: true });
    assert.equal(saved.status, 403, await saved.text());
    await assert.rejects(stat(join(work, '.git', 'hooks', 'pre-commit')), '.git の中に作った');
  });

  test('**.env などは、確かめるまで書かず、確かめたら書く**', async () => {
    const first = await send('PUT', '/api/file', { path: '.env', content: 'KEY=1\n' });
    const j = await first.json() as { confirm?: boolean; protected?: string };
    assert.equal(first.status, 409);
    assert.equal(j.confirm, true);
    await assert.rejects(stat(join(work, '.env')), '確かめる前に書いた');
    const again = await send('PUT', '/api/file', { path: '.env', content: 'KEY=1\n', confirmProtected: true });
    assert.equal(again.status, 200, await again.text());
    assert.equal(await readFile(join(work, '.env'), 'utf8'), 'KEY=1\n');
  });
});

describe('置き換えて書く', () => {
  test('**作業場の中のハードリンクを通して、外のファイルを書き換えない**', async (t) => {
    const outside = join(await tempDir('aas-hand-gaps-outside-'), 'secret.txt');
    await writeFile(outside, '外のファイル\n');
    try { await link(outside, join(work, 'linked.txt')); } catch { t.skip('この場所ではハードリンクを作れない'); return; }
    const r = await send('PUT', '/api/file', { path: 'linked.txt', content: '書き換え\n' });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(outside, 'utf8'), '外のファイル\n', '外のファイルを書き換えた');
    assert.equal(await readFile(join(work, 'linked.txt'), 'utf8'), '書き換え\n');
  });

  test('一時ファイルを残さない', async () => {
    await writeFile(join(work, 'tidy.txt'), 'もと\n');
    const r = await send('PUT', '/api/file', { path: 'tidy.txt', content: 'あと\n' });
    assert.equal(r.status, 200);
    assert.deepEqual((await readdir(work)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('**書く前の権限を保つ**', { skip: process.platform === 'win32' ? 'Windows には実行の権限が無い' : false }, async () => {
    const { chmod } = await import('node:fs/promises');
    await writeFile(join(work, 'run.sh'), '#!/bin/sh\n');
    await chmod(join(work, 'run.sh'), 0o755);
    const r = await send('PUT', '/api/file', { path: 'run.sh', content: '#!/bin/sh\necho hi\n' });
    assert.equal(r.status, 200);
    assert.equal((await stat(join(work, 'run.sh'))).mode & 0o777, 0o755);
  });
});

describe('消されたあとで作り直す', () => {
  test('**その間に別の所で作られていたら、上書きせずに断る**', async () => {
    await writeFile(join(work, 'again.txt'), 'AI が作り直した\n');
    const r = await send('PUT', '/api/file', { path: 'again.txt', content: '人の版\n', absent: true });
    const j = await r.json() as { conflict?: boolean; content?: string };
    assert.equal(r.status, 409);
    assert.equal(j.content, 'AI が作り直した\n');
    assert.equal(await readFile(join(work, 'again.txt'), 'utf8'), 'AI が作り直した\n');
  });
});

describe('Windows の予約された名前', () => {
  test('**Windows では予約された名前・末尾の点と空白を断り、ほかの OS では断らない**', async () => {
    const { windowsReserved } = await import('../src/ui/server.ts');
    for (const bad of ['nul', 'aux.js', 'sub/CON.txt', 'com1', 'lpt9.log', 'a.txt.', 'b ']) {
      assert.ok(windowsReserved(bad, 'win32'), bad);
    }
    for (const ok of ['null.js', 'auxiliary.ts', 'console.log', 'a.txt', '../x']) {
      assert.equal(windowsReserved(ok, 'win32'), undefined, ok);
    }
    assert.equal(windowsReserved('aux.js', 'linux'), undefined);
  });
});

describe('差分の作業場', () => {
  test('**別の作業場で出た差分は、いまの作業場に当てない**', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const other = join(await tempDir('aas-hand-gaps-other-'), 'work');
    await mkdir(other, { recursive: true });
    await writeFile(join(work, 'same.txt'), 'one\nTWO\n');
    await writeFile(join(other, 'same.txt'), 'one\nTWO\n');
    const diff = unifiedDiff('same.txt', 'one\ntwo\n', 'one\nTWO\n');
    // いまの作業場（work）で出た差分として配る
    server.broadcast({ type: 'session', event: { type: 'diff', path: 'same.txt', diff, added: 1, removed: 1 } } as never);
    const moved = await send('PUT', '/api/config', { workRoot: other });
    assert.equal(moved.status, 200, await moved.text());
    try {
      const r = await send('POST', '/api/revert', { path: 'same.txt', diff, picks: [{ hunk: 0 }] });
      const j = await r.json() as { moved?: boolean };
      assert.equal(r.status, 409, JSON.stringify(j));
      assert.equal(j.moved, true);
      assert.equal(await readFile(join(other, 'same.txt'), 'utf8'), 'one\nTWO\n', '別の作業場の差分を当てた');
    } finally {
      await send('PUT', '/api/config', { workRoot: work });
    }
  });
});
