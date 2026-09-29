/**
 * 画面の口で、フォルダを見られないのを「空」「無い」と取り違えない・一覧ごと道連れにしない。
 *
 *   ・消した会話の捨て場を読めないと、会話の一覧の口が 500 になり、画面は生きている会話の一覧まで黙って出さなくなった
 *   ・戻り先のフォルダを読めないと、戻す一覧の口が 500 になり、画面は前に描いた古い一覧を出したままになった
 *   ・見られない場所にフォルダを作ろうとすると、既に在るのに「作った」と返していた
 *
 * 読めなさは fs/promises の関数をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';

const require = createRequire(import.meta.url);
const dir = await tempDir('aas-unreadable-dirs-server-');
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

/** fs/promises の `name` を、道が `hit` に当たるときだけ EACCES で失敗させて `fn` を回す。 */
async function failing<T>(name: 'readdir' | 'stat', hit: (p: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const real = fsp[name] as (...a: unknown[]) => Promise<unknown>;
  (fsp as Record<string, unknown>)[name] = ((p: unknown, ...rest: unknown[]) => typeof p === 'string' && hit(p)
    ? Promise.reject(Object.assign(new Error(`EACCES: ${name} failed`), { code: 'EACCES' }))
    : real(p, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as Record<string, unknown>)[name] = real;
    syncBuiltinESMExports();
  }
}

describe('画面の口で、フォルダを見られないとき', () => {
  const work = join(dir, 'work');
  let base = '';
  let server: InstanceType<typeof UiServer>;
  before(async () => {
    await mkdir(work, { recursive: true });
    server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { root: work } } as typeof DEFAULT_CONFIG, port: 0 });
    base = (await server.start()).replace(/\/$/, '');
  });
  after(async () => { await server.stop(); });

  test('捨て場を読めなくても、会話の一覧は返し、読めないことを言う', async () => {
    const trash = join(dir, 'state', 'conversations', 'trash');
    const r = await failing('readdir', (p) => p === trash, () => fetch(`${base}/api/conversations`));
    const body = await r.json() as { list?: unknown[]; trash?: unknown[]; trashError?: string };
    assert.equal(r.status, 200, `一覧ごと落とした: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.list));
    assert.deepEqual(body.trash, []);
    assert.match(body.trashError ?? '', /消した会話を読めません/);
  });

  test('捨て場が読めるときは、読めないと言わない', async () => {
    const body = await (await fetch(`${base}/api/conversations`)).json() as { trashError?: string };
    assert.equal(body.trashError, undefined);
  });

  test('戻り先のフォルダを読めなくても 500 にせず、読めないことを返す', async () => {
    const undo = join(dir, 'state', 'undo');
    await mkdir(undo, { recursive: true });
    const r = await failing('readdir', (p) => p === undo, () => fetch(`${base}/api/undo`));
    const body = await r.json() as { list?: unknown[]; error?: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(body.list, []);
    assert.match(body.error ?? '', /読めません/);
  });

  test('見られない場所にフォルダを作るとき、「作った」と返さない', async () => {
    const r = await failing('stat', (p) => p.endsWith(`${'/'}blocked`) || p.endsWith('\\blocked'), () => fetch(`${base}/api/files/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'blocked', kind: 'dir' }),
    }));
    const body = await r.json() as { error?: string; created?: string };
    assert.equal(r.status, 409, `作ったと返した: ${JSON.stringify(body)}`);
    assert.match(body.error ?? '', /確かめられません/);
  });
});
