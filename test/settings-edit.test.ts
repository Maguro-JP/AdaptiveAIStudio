/**
 * 画面から設定を書き換えるとき、壊れた・読めない設定を丸ごと上書きして消さない。
 * 設定は利用者が書くファイルで、カンマ一つの書き損じでも、そこに書いた他の設定は全部生きている。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { saveRuntime, saveMcpServer, removeMcpServer, saveWorkRoot, readSavedRuntime, savedWorkRoot } from '../src/ui/settings.ts';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG } from '../src/config.ts';
import { UiServer } from '../src/ui/server.ts';

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

  test('**同時に保存しても、互いの変更を消さない**（読んでから書くまでを一列に並べる）', async () => {
    const { at } = await configAt(JSON.stringify({ keep: 1 }));
    await Promise.all([
      saveRuntime('llamacpp', '/m'),
      saveMcpServer('github', { url: 'https://x' }),
      saveWorkRoot('/w'),
      saveMcpServer('other', { url: 'https://y' }),
    ]);
    const got = JSON.parse(await readFile(at, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(got.keep, 1 as never);
    assert.equal(got.runtime?.kind, 'llamacpp');
    assert.deepEqual(Object.keys((got.mcp as { servers: object }).servers).sort(), ['github', 'other']);
    assert.deepEqual(got.agent, { root: '/w' });
  });

  test('**BOM の付いた設定を、起動時の読み込みでも画面の表示でも読む**', async () => {
    await configAt('\uFEFF' + JSON.stringify({ runtime: { kind: 'llamacpp', modelsDir: '/m' }, agent: { root: '/w' } }));
    assert.equal(loadConfig().config.runtime?.kind, 'llamacpp');
    assert.equal((await readSavedRuntime()).kind, 'llamacpp');
    assert.equal(await savedWorkRoot(), '/w');
  });
});

describe('繋いだものを外す', () => {
  test('**設定が壊れていたら、外したと言わず理由を返し、動いている設定からも外さない**', async () => {
    const { dir, at } = await configAt(JSON.stringify({ mcp: { servers: { github: { url: 'https://x' } } } }));
    const savedHome = process.env.AAS_HOME;
    process.env.AAS_HOME = join(dir, 'home');
    const s = new UiServer({ config: loadConfig().config, port: 0 });
    try {
      const url = await s.start();
      const good = await readFile(at, 'utf8');
      await writeFile(at, good.replace(/}\s*$/, ',}'));
      const r = await fetch(new URL('/api/mcp/connect?id=github', url), { method: 'DELETE' });
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /書き換えませんでした/);
      await writeFile(at, good); // 直して押し直せば外れる（動いている設定に残っている）
      const again = await fetch(new URL('/api/mcp/connect?id=github', url), { method: 'DELETE' });
      assert.equal(again.status, 200, '動いている設定から先に外していた');
    } finally {
      await s.stop();
      if (savedHome === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = savedHome;
    }
  });
});
describe('保存してある設定を読めないとき', () => {
  test('既定の保存先を返さず、読めないと言う（画面が既定を送り返して、決めた保存先を上書きしないように）', async () => {
    const { at } = await configAt(JSON.stringify({ runtime: { kind: 'inproc', modelsDir: '/d/models' } }));
    // 読めなさは、設定の場所にフォルダを置いて作る（権限に頼らない）
    const { rm } = await import('node:fs/promises');
    await rm(at);
    await mkdir(at);
    await assert.rejects(readSavedRuntime(), /設定.*を読めません/);
    // 読めない設定では、読み込みそのものが止めて言う（既定で黙って動かさない）。画面の入口（src/cli/ui.ts）と同じく、既定で開く
    assert.throws(() => loadConfig(), ConfigBroken);
    const s = new UiServer({ port: 0, config: { ...structuredClone(DEFAULT_CONFIG), runtime: { kind: 'inproc' } } });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const body = await (await fetch(`${base}/api/config`)).json() as { error?: string; gguf?: unknown[]; modelsDir?: string };
      assert.match(body.error ?? '', /読めません/, `読めないのに設定を返した: ${JSON.stringify(body)}`);
      assert.deepEqual(body.gguf, [], 'モデルを切り替える口を出した（押すと既定の保存先を書き戻す）');
    } finally {
      await s.stop();
    }
  });

  test('無いだけなら空（まだ保存していない）', async () => {
    await configAt();
    assert.deepEqual(await readSavedRuntime(), {});
  });
});
