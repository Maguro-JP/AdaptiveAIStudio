/**
 * 画面から設定を変える口。
 *
 * cmd の窓でしかできないことを残さない、が狙い。ただし
 * **設定ファイル全部を書けるようにはしない**。設定という顔をして
 * 道具の振る舞いを丸ごと差し替えられる口になるため。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { UiServer, RUNTIME_KINDS } from '../src/ui/server.ts';
import { loadConfig } from '../src/config.ts';

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(): Promise<{ url: string; at: string; models: string }> {
  const dir = await tempDir('aas-cfg-');
  const models = join(dir, 'models');
  await mkdir(models, { recursive: true });
  await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'x');
  const at = join(dir, 'aas.config.json');
  process.env.AAS_CONFIG = at;
  process.env.AAS_HOME = join(dir, 'home');
  const s = new UiServer({ config: loadConfig().config, port: 0 });
  servers.push(s);
  return { url: await s.start(), at, models };
}

describe('設定の口', () => {
  test('いまの設定と、置いてある GGUF が読める', async () => {
    const { url, models } = await start();
    const r = await fetch(new URL('/api/config', url)).then((x) => x.json()) as {
      kinds: { id: string }[]; kind: string; gguf: { ref: string }[]; modelsDir: string;
    };
    assert.deepEqual(r.kinds.map((k) => k.id), [...RUNTIME_KINDS]);
    assert.equal(r.kind, 'ollama');
    // 置き場を指していなくても、既定の置き場を答える（空にしない）。
    assert.ok(r.modelsDir.length > 0);
    void models;
  });

  test('決めたものだけを書き換える', async () => {
    const { url, at, models } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inproc', modelsDir: models }),
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(await readFile(at, 'utf8')) as { runtime: Record<string, string> };
    assert.equal(saved.runtime.kind, 'inproc');
    assert.equal(saved.runtime.modelsDir, models);

    // 書いたものが読み返せること。**保存した直後に古い値を見せない。**
    const after = await fetch(new URL('/api/config', url)).then((x) => x.json()) as {
      kind: string; gguf: { ref: string }[]; restartNeeded: boolean; active: { kind: string };
    };
    assert.equal(after.kind, 'inproc');
    assert.deepEqual(after.gguf.map((g) => g.ref), ['qwen2.5-3b-instruct-q4_k_m.gguf']);
    // いま動いているものは別。黙って効いた顔をしない。
    assert.equal(after.active.kind, 'ollama');
    assert.equal(after.restartNeeded, true);
  });

  test('知らない動かし方は受け取らない', async () => {
    const { url } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'なんでも実行する' }),
    });
    assert.equal(r.status, 400);
  });

  test('画面から見えない設定を消さない', async () => {
    const { url, at } = await start();
    // 画面に無い設定が既にある状態にする。
    await writeFile(at, JSON.stringify({
      system: 'これは残らなければならない',
      runtime: { kind: 'ollama', desiredContext: 8192 },
    }), 'utf8');
    await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inproc' }),
    });
    const saved = JSON.parse(await readFile(at, 'utf8')) as {
      system: string; runtime: { kind: string; desiredContext: number };
    };
    assert.equal(saved.system, 'これは残らなければならない');
    assert.equal(saved.runtime.desiredContext, 8192, '画面に無い設定を消した');
    assert.equal(saved.runtime.kind, 'inproc');
  });
});
