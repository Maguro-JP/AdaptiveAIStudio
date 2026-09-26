/**
 * ディスクに状態を覚えておく部品（戻す仕組み・記憶・やり残し）で、覚えたものを失う・取り違える形を止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, appendFile, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
import { UndoStore } from '../src/core/undo.ts';
import { Memory } from '../src/memory/memory.ts';
import { UnfinishedWork } from '../src/core/unfinished.ts';

describe('戻す仕組み', () => {
  test('**作業場を変えたら、前の作業場の戻り先を今の作業場に当てない**', async () => {
    const base = await tempDir('aas-undo-roots-');
    const a = join(base, 'a');
    const b = join(base, 'b');
    const dir = join(base, 'undo');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, 'config.json'), 'A の元\n');
    await writeFile(join(b, 'config.json'), 'B の中身\n');
    await writeFile(join(b, 'notes.md'), 'B のメモ\n');
    const ua = new UndoStore(a, dir);
    await ua.begin('A で直す');
    ua.capture('config.json', 'A の元\n');
    ua.capture('notes.md', undefined);
    const point = await ua.end();
    assert.ok(point);
    const ub = new UndoStore(b, dir);
    assert.deepEqual(await ub.list(), [], '別の作業場の戻り先が見えた');
    assert.equal(await ub.restore(point.id), undefined, '別の作業場の戻り先を当てた');
    assert.equal(await readFile(join(b, 'config.json'), 'utf8'), 'B の中身\n');
    assert.equal(await readFile(join(b, 'notes.md'), 'utf8'), 'B のメモ\n');
    assert.equal((await ua.list()).length, 1, '元の作業場からは見えるまま');
  });

  test('**戻せなかったファイルがある戻り先は消さず、原因を除けばもう一度戻せる**', async () => {
    const root = await tempDir('aas-undo-fail-');
    const u = new UndoStore(root, join(await tempDir('aas-undo-fail-state-'), 'undo'));
    await writeFile(join(root, 'a.txt'), 'a1\n');
    await writeFile(join(root, 'b.txt'), 'b1\n');
    await u.begin('直す');
    u.capture('a.txt', 'a0\n');
    u.capture('b.txt', 'b0\n');
    const point = (await u.end())!;
    // b.txt を中身のあるフォルダにして、戻せない形を作る。
    await rm(join(root, 'b.txt'));
    await mkdir(join(root, 'b.txt'));
    await writeFile(join(root, 'b.txt', 'x'), 'x');
    const first = await u.restore(point.id);
    assert.deepEqual(first?.failed, ['b.txt']);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a0\n');
    const left = await u.list();
    assert.equal(left.length, 1, '戻せなかったのに戻り先を消した');
    assert.deepEqual(left[0]!.paths, ['b.txt'], '戻せた分まで残した');
    await rm(join(root, 'b.txt'), { recursive: true });
    const second = await u.restore(left[0]!.id);
    assert.deepEqual(second?.failed, []);
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b0\n');
    assert.deepEqual(await u.list(), []);
  });

  test('戻り先は一時ファイルから置き換えて書き、一時ファイルを残さない', async () => {
    const root = await tempDir('aas-undo-tmp-');
    const dir = join(await tempDir('aas-undo-tmp-state-'), 'undo');
    const u = new UndoStore(root, dir);
    await u.begin('直す');
    u.capture('a.txt', undefined);
    await u.end();
    assert.ok((await readdir(dir)).every((n) => n.endsWith('.json')), `一時ファイルが残った: ${(await readdir(dir)).join(',')}`);
  });
});

describe('記憶', () => {
  test('**一度読めなかっただけで空として始め、覚えていたものを上書きしない**', async () => {
    const path = join(await tempDir('aas-mem-busy-'), 'memory.jsonl');
    const m1 = new Memory(path);
    for (let i = 0; i < 5; i += 1) m1.remember({ kind: 'fact', title: `決めたこと ${i}`, tags: ['x'] });
    await m1.save();
    const before = await readFile(path, 'utf8');
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const m2 = new Memory(path, { read: () => Promise.reject(busy) });
    await m2.load();
    m2.remember({ kind: 'fact', title: '新しいこと', tags: ['y'] });
    await assert.rejects(m2.save(), /読めなかった/);
    assert.equal(await readFile(path, 'utf8'), before, '覚えていたものを上書きした');
  });

  test('ファイルが無いときは、空から始めて保存できる（対）', async () => {
    const path = join(await tempDir('aas-mem-none-'), 'memory.jsonl');
    const m = new Memory(path);
    await m.load();
    m.remember({ kind: 'fact', title: 'はじめて', tags: [] });
    await m.save();
    assert.match(await readFile(path, 'utf8'), /はじめて/);
  });

  test('形の違う行（tags が無い）は読み飛ばし、思い出すときに止まらない', async () => {
    const path = join(await tempDir('aas-mem-shape-'), 'memory.jsonl');
    await writeFile(path, '{"id":"m1","kind":"fact","title":"テスト 大事"}\n');
    const m = new Memory(path);
    await m.load();
    assert.doesNotThrow(() => m.recall('テスト'));
  });
});

describe('やり残しの記録', () => {
  const item = { request: 'src を直して', why: 'maxTurns' as const, note: '40ターン' };

  async function crowded() {
    const path = join(await tempDir('aas-unf-safe-'), 'u.jsonl');
    const w = new UnfinishedWork(path);
    // 閉じた行を積んで、次の add で畳みが走る形にする。
    const lines: string[] = [];
    for (let i = 0; i < 10; i += 1) lines.push(JSON.stringify({ t: 'add', item: { ...item, request: `keep${i}`, id: `k${i}`, attempts: 0, nextAt: 0, createdAt: new Date(i).toISOString() } }));
    for (let i = 0; i < 195; i += 1) {
      lines.push(JSON.stringify({ t: 'add', item: { ...item, request: `old${i}`, id: `o${i}`, attempts: 0, nextAt: 0, createdAt: new Date(100 + i).toISOString() } }));
      lines.push(JSON.stringify({ t: 'close', id: `o${i}`, how: 'done' }));
    }
    await writeFile(path, `${lines.join('\n')}\n`);
    return { w, path };
  }

  /**
   * 畳みが書き戻す直前に、別の操作を始めさせて少し待つ（書き戻しの口に割り込みを差し込む）。
   * 割り込ませないと、この機械では畳みが速すぎて重ならない。
   */
  async function duringCompact(dir: string, meanwhile: () => Promise<unknown>): Promise<() => void> {
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const real = fsp.writeFile;
    let fired = false;
    (fsp as { writeFile: unknown }).writeFile = async (...args: Parameters<typeof real>) => {
      if (!fired && String(args[0]).startsWith(dir)) {
        fired = true;
        void meanwhile().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
      }
      return real(...args);
    };
    syncBuiltinESMExports();
    return () => { (fsp as { writeFile: unknown }).writeFile = real; syncBuiltinESMExports(); };
  }

  test('**畳みの間に足したものを消さない**', async () => {
    const { w, path } = await crowded();
    const other = new UnfinishedWork(path);
    const undo = await duringCompact(join(path, '..'), () => other.add({ ...item, request: '畳みの間に足した' }));
    try {
      await w.add({ ...item, request: 'new' });
    } finally { undo(); }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok((await w.list()).some((u) => u.request === '畳みの間に足した'), '畳みの間に足したものが消えた');
  });

  test('**畳みの間に取り消したものを、生き返らせない**', async () => {
    const { w: w2, path } = await crowded();
    const undo2 = await duringCompact(join(path, '..'), () => w2.cancel('k0'));
    try {
      await w2.add({ ...item, request: 'new' });
    } finally { undo2(); }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!(await w2.list()).some((u) => u.id === 'k0'), '取り消したものが生き返った');
  });

  test('畳みは一時ファイルから置き換える（その場で上書きしない）', async () => {
    const { w, path } = await crowded();
    const before = (await stat(path)).ino;
    await w.add({ ...item, request: 'new' });
    assert.notEqual((await stat(path)).ino, before, 'その場で上書きした');
    assert.ok((await readdir(join(path, '..'))).every((n) => !n.endsWith('.tmp')));
  });

  test('形の違う行（item が無い）は捨て、一覧を止めない', async () => {
    const path = join(await tempDir('aas-unf-shape-'), 'u.jsonl');
    const w = new UnfinishedWork(path);
    await w.add(item);
    await appendFile(path, '{"t":"add"}\nnull\n');
    assert.equal((await w.list()).length, 1);
  });
});
