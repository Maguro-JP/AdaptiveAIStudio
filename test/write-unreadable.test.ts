/**
 * 在るのに読めないファイルを、「新しく作る」と取り違えて書かない。
 *
 * 書く前の中身を読めない理由を問わず「無い」としていたので、書くツールも画面の手保存も、
 * 元から在るファイルを新規作成として書き、「戻す」には「前は無かった」と残した。戻すとそのファイルを消していた。
 *
 * 読めなさは fs/promises の readFile をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 * 失敗させるのは読むときだけで、書き込みは通る（読めないが書ける、の形）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { writeFileTool, editFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const require = createRequire(import.meta.url);
const dir = await tempDir('aas-write-unreadable-');
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
const realReadFile = fsp.readFile;

/** `path` だけ EACCES で読めなくする。戻すのは `restoreRead`。 */
function blockRead(path: string): void {
  (fsp as { readFile: unknown }).readFile = ((file: unknown, ...rest: unknown[]) => file === path
    ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    : (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as never;
  syncBuiltinESMExports();
}
function restoreRead(): void {
  (fsp as { readFile: unknown }).readFile = realReadFile;
  syncBuiltinESMExports();
}

/** `path` だけ EACCES で読めなくして `fn` を回す。 */
async function unreadable<T>(path: string, fn: () => Promise<T>): Promise<T> {
  blockRead(path);
  try {
    return await fn();
  } finally {
    restoreRead();
  }
}

describe('書くツール', () => {
  test('write_file: 読めないファイルには書かず、「前は無かった」とも記録しない', async () => {
    const root = await tempDir('aas-write-unreadable-tool-');
    const abs = join(root, 'a.txt');
    await writeFile(abs, 'もとの中身\n');
    const kept: Array<{ path: string; previous: unknown }> = [];
    let asked = false;
    const ctx: ToolContext = {
      root,
      signal: new AbortController().signal,
      approve: async () => { asked = true; return true; },
      beforeWrite: (path, previous) => { kept.push({ path, previous }); },
    };
    const r = await unreadable(abs, () => writeFileTool.run({ path: 'a.txt', content: '上書き\n' }, ctx));
    assert.equal(r.isError, true, `書けたことになっている: ${r.content}`);
    assert.match(r.content, /読めません/);
    assert.equal(asked, false, '新規作成の差分で承認を訊いた');
    assert.deepEqual(kept, [], '「前は無かった」と記録した');
    assert.equal(await readFile(abs, 'utf8'), 'もとの中身\n');
  });

  test('edit_file: 読めないファイルを「まだありません」と言わない', async () => {
    const root = await tempDir('aas-write-unreadable-tool-');
    const abs = join(root, 'a.txt');
    await writeFile(abs, 'もとの中身\n');
    const ctx: ToolContext = { root, signal: new AbortController().signal, approve: async () => true };
    const r = await unreadable(abs, () => editFileTool.run({ path: 'a.txt', find: 'もとの', replace: '新しい' }, ctx));
    assert.equal(r.isError, true);
    assert.match(r.content, /読めません/, `別の理由で断っている: ${r.content}`);
  });
});

describe('画面の手保存', () => {
  const work = join(dir, 'work');
  let base = '';
  let server: InstanceType<typeof UiServer>;
  before(async () => {
    await mkdir(work, { recursive: true });
    server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { root: work } } as typeof DEFAULT_CONFIG, port: 0 });
    base = (await server.start()).replace(/\/$/, '');
  });
  after(async () => { await server.stop(); });

  test('読めないファイルは保存せず、そう言う', async () => {
    const abs = join(work, 'b.txt');
    await writeFile(abs, 'もとの中身\n');
    const r = await unreadable(abs, () => fetch(`${base}/api/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'b.txt', content: '上書き\n' }),
    }));
    const body = await r.json() as { error?: string };
    assert.equal(r.status, 409, `保存した: ${JSON.stringify(body)}`);
    assert.match(body.error ?? '', /読めない/);
    assert.equal(await readFile(abs, 'utf8'), 'もとの中身\n');
  });

  test('行ごとに戻す口も、読めないファイルには書かない', async () => {
    const abs = join(work, 'c.txt');
    await writeFile(abs, 'one\ntwo\n');
    const diff = '--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,2 @@\n one\n+two\n';
    const r = await unreadable(abs, () => fetch(`${base}/api/revert`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'c.txt', diff, picks: [{ hunk: 0 }] }),
    }));
    const body = await r.json() as { error?: string };
    assert.equal(r.status, 409, `戻した・別の理由で断った: ${r.status} ${JSON.stringify(body)}`);
    assert.match(body.error ?? '', /読めない/);
    assert.equal(await readFile(abs, 'utf8'), 'one\ntwo\n');
  });
});

describe('画面の手保存で、錠を取った後に読めなくなったとき', () => {
  const work2 = join(dir, 'work2');
  let base2 = '';
  let server2: InstanceType<typeof UiServer>;
  let blockAfterLock: string | undefined;
  before(async () => {
    await mkdir(work2, { recursive: true });
    server2 = new UiServer({
      config: { ...DEFAULT_CONFIG, agent: { root: work2 } } as typeof DEFAULT_CONFIG,
      port: 0,
      // 錠を取った後の読み直しの手前で、読めなくする
      afterHandLock: async () => { if (blockAfterLock) blockRead(blockAfterLock); },
    });
    base2 = (await server2.start()).replace(/\/$/, '');
  });
  after(async () => { await server2.stop(); });

  test('保存せず、読めないと言う', async () => {
    const abs = join(work2, 'd.txt');
    await writeFile(abs, 'もとの中身\n');
    blockAfterLock = abs;
    let r: Response;
    try {
      r = await fetch(`${base2}/api/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'd.txt', content: '上書き\n' }),
      });
    } finally {
      blockAfterLock = undefined;
      restoreRead();
    }
    const body = await r.json() as { error?: string };
    assert.equal(r.status, 409, `保存した: ${JSON.stringify(body)}`);
    assert.match(body.error ?? '', /読めない/);
    assert.equal(await readFile(abs, 'utf8'), 'もとの中身\n');
  });
});
