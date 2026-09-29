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

/** `path` だけ EACCES で読めなくして `fn` を回す。 */
async function unreadable<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
  const real = fsp.readFile;
  (fsp as { readFile: unknown }).readFile = ((file: unknown, ...rest: unknown[]) => file === path
    ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    : (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as { readFile: unknown }).readFile = real;
    syncBuiltinESMExports();
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
});
