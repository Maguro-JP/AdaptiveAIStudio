/**
 * 画面の並び（`layout.json`）と見た目（`theme.json`）を、壊れた・読めないときに黙って既定へ戻さない。
 * 書くのは一時ファイルから付け替える（途中で落ちても前の中身が残る）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { loadLayout, saveLayout, loadTheme, saveTheme } from '../src/ui/server.ts';

let dir = '';
let saved: string | undefined;
before(() => { saved = process.env.AAS_STATE_DIR; });
after(() => { if (saved === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = saved; });
async function fresh(): Promise<string> {
  dir = await tempDir('aas-layout-f-');
  process.env.AAS_STATE_DIR = dir;
  return dir;
}

for (const [what, file, load, save] of [
  ['画面の並び', 'layout.json', loadLayout, (x: unknown) => saveLayout(x as never)],
  ['見た目', 'theme.json', loadTheme, (x: unknown) => saveTheme(x as never)],
] as const) {
  describe(what, () => {
    test('まだ無ければ既定で、直した記録は無い（対）', async () => {
      await fresh();
      assert.deepEqual((await load()).repairs, []);
    });

    test(`**壊れていたら既定で出し、そう言う。元のファイルは脇に残す**`, async () => {
      await fresh();
      await writeFile(join(dir, file), '{"panels": [');
      const r = await load();
      assert.equal(r.repairs.length, 1, '黙って既定に戻した');
      assert.match(r.repairs[0]!.detail, /壊れていた/);
      const aside = (await readdir(dir)).find((n) => n.startsWith(`${file}.broken-`));
      assert.ok(aside, '壊れたファイルを残していない');
      assert.equal(await readFile(join(dir, aside), 'utf8'), '{"panels": [');
    });

    test(`**読めないときは既定で出し、そう言う**`, async () => {
      await fresh();
      await mkdir(join(dir, file)); // 読めない（EISDIR）
      const r = await load();
      assert.equal(r.repairs.length, 1, '黙って既定に戻した');
      assert.match(r.repairs[0]!.detail, /読めなかった/);
    });

    test('**書いたものを読み直せて、一時ファイルを残さない**', async () => {
      await fresh();
      const first = await load();
      const value = 'layout' in first ? first.layout : first.theme;
      await save(value);
      const again = await load();
      assert.deepEqual('layout' in again ? again.layout : again.theme, value);
      assert.deepEqual(await readdir(dir), [file]);
    });

    test('**書くのは一時ファイルから付け替え（その場で書き足さない。途中で落ちても前の中身が残る）**', async () => {
      await fresh();
      const first = await load();
      const value = 'layout' in first ? first.layout : first.theme;
      await save(value);
      const before = (await stat(join(dir, file), { bigint: true })).ino; // Windows の番号は 2^53 を超えうる
      await save(value);
      assert.notEqual((await stat(join(dir, file), { bigint: true })).ino, before, '同じファイルへその場で書いた');
    });

    test('**書けなければ投げる（保存したと返さない）。一時ファイルを残さない**', async () => {
      await fresh();
      const first = await load();
      const value = 'layout' in first ? first.layout : first.theme;
      await mkdir(join(dir, file, 'x'), { recursive: true }); // 付け替え先が中身のあるフォルダで、置き換えられない
      await assert.rejects(save(value));
      assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], '一時ファイルを残した');
    });
  });
}
