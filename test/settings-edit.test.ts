/**
 * 画面から設定を書き換えるとき、壊れた・読めない設定を丸ごと上書きして消さない。
 * 設定は利用者が書くファイルで、カンマ一つの書き損じでも、そこに書いた他の設定は全部生きている。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { saveRuntime, saveMcpServer, removeMcpServer, saveWorkRoot } from '../src/ui/settings.ts';

let saved: string | undefined;
before(() => { saved = process.env.AAS_CONFIG; });
after(() => { if (saved === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = saved; });

async function configAt(text?: string): Promise<{ dir: string; at: string }> {
  const dir = await tempDir('aas-cfg-edit-');
  const at = join(dir, 'aas.config.json');
  if (text !== undefined) await writeFile(at, text);
  process.env.AAS_CONFIG = at;
  return { dir, at };
}

const edits: Array<[string, () => Promise<unknown>]> = [
  ['saveRuntime', () => saveRuntime('llamacpp', '/m')],
  ['saveMcpServer', () => saveMcpServer('github', { url: 'https://x' })],
  ['removeMcpServer', () => removeMcpServer('github')],
  ['saveWorkRoot', () => saveWorkRoot('/w')],
];

describe('設定を書き換える', () => {
  for (const [name, edit] of edits) {
    for (const [what, text] of [
      ['壊れた JSON', '{\n  "providers": [],\n  "mcp": { "servers": { "github": {} } },\n}'],
      ['null', 'null'],
      ['配列', '[1]'],
    ] as const) {
      test(`**${name}: 設定が${what}なら書き換えず、理由を言う（中身は元のまま）**`, async () => {
        const { at } = await configAt(text);
        await assert.rejects(edit(), /書き換えませんでした/);
        assert.equal(await readFile(at, 'utf8'), text, '壊れた設定を上書きした');
      });
    }

    test(`**${name}: 在るのに読めなければ書き換えない**`, async () => {
      const { at } = await configAt();
      await mkdir(at); // 読めない（EISDIR）
      await assert.rejects(edit(), /読めないので、書き換えませんでした/);
      assert.ok((await stat(at)).isDirectory());
    });
  }

  test('**BOM の付いた設定も読み、他の設定を残して書き換える**', async () => {
    const { at } = await configAt('﻿' + JSON.stringify({ providers: ['keep'], mcp: { servers: { github: { url: 'u' } } } }));
    await saveWorkRoot('/w');
    const got = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(got.providers, ['keep']);
    assert.deepEqual(got.agent, { root: '/w' });
    assert.deepEqual((await removeMcpServer('github')).removed, true);
  });

  test('**項目が配列でも、番号の鍵を混ぜない**（runtime が [1] なら、入れ物として扱わず作り直す）', async () => {
    const { at } = await configAt(JSON.stringify({ runtime: ['x'], agent: ['y'] }));
    await saveRuntime('llamacpp', '/m');
    await saveWorkRoot('/w');
    const got = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(got.runtime, { kind: 'llamacpp', modelsDir: '/m' });
    assert.deepEqual(got.agent, { root: '/w' });
  });

  test('**項目が null でも止まらない**（runtime・mcp・agent が null）', async () => {
    const { at } = await configAt(JSON.stringify({ runtime: null, mcp: null, agent: null, keep: 1 }));
    await saveRuntime('llamacpp', '/m');
    await saveMcpServer('github', { url: 'https://x' });
    await saveWorkRoot('/w');
    const got = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
    assert.equal(got.keep, 1);
    assert.deepEqual(got.runtime, { kind: 'llamacpp', modelsDir: '/m' });
  });

  test('**書くのは一時ファイルから付け替え（その場で書かない）。無ければ作る（対）**', async () => {
    const { dir, at } = await configAt();
    await saveRuntime('llamacpp', '/m');
    const first = (await stat(at, { bigint: true })).ino;
    await saveWorkRoot('/w');
    assert.notEqual((await stat(at, { bigint: true })).ino, first, 'その場で書いた');
    assert.deepEqual(await readdir(dir), ['aas.config.json']);
  });
});
