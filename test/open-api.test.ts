/**
 * 道を OS で開く口。
 *
 * 開けるのは、このプログラムが使っている場所（作業場・モデル・記録・プログラム）の中だけ。
 * 外の道・無い道・この機械のものでない道は開かない。本物の explorer / open / xdg-open は
 * 起こさず、起こす係をモックにして、渡る命令と引数を見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { revealCommand } from '../src/core/opener.ts';

const state = await tempDir('aas-open-state-');
const work = await tempDir('aas-open-work-');
const models = await tempDir('aas-open-models-');
const elsewhere = await tempDir('aas-open-elsewhere-');
process.env.AAS_STATE_DIR = state;
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const spawned: Array<{ command: string; args: string[] }> = [];
let refuse = false;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  await writeFile(join(work, 'a.txt'), 'x', 'utf8');
  await mkdir(join(work, 'sub'), { recursive: true });
  await writeFile(join(models, 'm.gguf'), 'GGUF', 'utf8');
  await writeFile(join(elsewhere, 'secret.txt'), 'x', 'utf8');
  server = new UiServer({
    config: {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, root: work },
      runtime: { kind: 'inproc', modelsDir: models },
    } as typeof DEFAULT_CONFIG,
    port: 0,
    opener: async (command, args) => { if (refuse) throw new Error('起こせない'); spawned.push({ command, args }); },
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

const open = (path: unknown) => fetch(`${base}/api/open`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
});

describe('道を開く', () => {
  test('作業場の中のファイルは、選んだ状態でフォルダを開く命令になる', async () => {
    spawned.length = 0;
    const r = await open(join(work, 'a.txt'));
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    const real = await realpath(join(work, 'a.txt'));
    assert.deepEqual(spawned, [revealCommand(process.platform, real, false)]);
    assert.deepEqual(j, { opened: real, dir: false });
  });

  test('フォルダはそのまま開く', async () => {
    spawned.length = 0;
    const r = await open(join(work, 'sub'));
    assert.equal(r.status, 200);
    assert.deepEqual(spawned, [revealCommand(process.platform, await realpath(join(work, 'sub')), true)]);
  });

  test('モデルのフォルダも開ける', async () => {
    spawned.length = 0;
    assert.equal((await open(join(models, 'm.gguf'))).status, 200);
    assert.equal(spawned.length, 1);
  });

  test('**使っている場所の外は開かない**', async () => {
    spawned.length = 0;
    const r = await open(join(elsewhere, 'secret.txt'));
    assert.equal(r.status, 403);
    assert.deepEqual(spawned, [], '外の道で命令を起こしている');
  });

  test('無い道・相対の道・この機械のものでない道は断る', async () => {
    spawned.length = 0;
    assert.equal((await open(join(work, 'nope.txt'))).status, 404);
    assert.equal((await open('a.txt')).status, 400);
    assert.equal((await open('')).status, 400);
    assert.equal((await open(42)).status, 400);
    if (process.platform !== 'win32') assert.equal((await open('C:\\Users\\x\\a.txt')).status, 400);
    assert.deepEqual(spawned, []);
  });

  test('起こせなかったら、そう言う', async () => {
    refuse = true;
    try {
      const r = await open(join(work, 'a.txt'));
      assert.equal(r.status, 500);
      assert.match(((await r.json()) as { error: string }).error, /開けませんでした/);
    } finally { refuse = false; }
  });
});

describe('モデルの一覧は絶対の道も返す', () => {
  test('GGUF を置く道では path が付く', async () => {
    const j = await (await fetch(`${base}/api/models`)).json() as { installed: { ref: string; path?: string }[] };
    assert.equal(j.installed.find((m) => m.ref === 'm.gguf')?.path, join(models, 'm.gguf'));
  });
});
