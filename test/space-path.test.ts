/**
 * 道に空白が入っていても通る。
 *
 * 配る先の道は `C:\Users\user\OneDrive - Business1\…` で、
 * **空白と `-` が入っている。**殻へ渡す所で割れると、検証コマンドが
 * 打てなくなったり、別の場所を見に行ったりする。ここでは起きないので、
 * 気づけるのは配ってからになる。**先に踏んでおく。**
 *
 * 走らせる場所に依らない（空白の扱いは OS を問わない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { execCommand } from '../src/agent/shell-exec.ts';
import { readFileTool, writeFileTool, listFilesTool } from '../src/agent/tools/fs.ts';
import { scriptCommand } from '../src/agent/prefetch.ts';

/** 配る先と同じ形の道を作る。 */
async function spacedRoot(): Promise<string> {
  const at = join(await tempDir('aas-space-'), 'OneDrive - Business1', 'Workspace', 'AdaptiveAIStudio');
  await mkdir(join(at, 'src'), { recursive: true });
  return at;
}

const ctx = (root: string) => ({
  root,
  signal: new AbortController().signal,
  approve: () => Promise.resolve(true as const),
});

describe('空白を含む道', () => {
  test('書いて、読んで、並べられる', async () => {
    const root = await spacedRoot();
    const name = 'src/新しい ファイル - 1.ts';
    assert.match(
      (await writeFileTool.run({ path: name, content: 'export const x = 1;\n' }, ctx(root) as never)).content,
      /作成/,
    );
    assert.match(
      (await readFileTool.run({ path: name }, ctx(root) as never)).content,
      /export const x = 1;/,
    );
    assert.match(
      (await listFilesTool.run({ path: 'src' }, ctx(root) as never)).content,
      /新しい ファイル - 1\.ts/,
    );
  });

  test('検証コマンドを、その場で打てる', async () => {
    const root = await spacedRoot();
    // npm が無い機械でも打てる形（package.json の中身をそのまま打つ）。
    const scripts = { test: `node -e "require('fs').writeFileSync('ran.txt','x')"` };
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts }));
    const command = scriptCommand('npm', 'test', scripts, (c) => c === 'node');
    assert.ok(command, '打ち方が決まらない');
    const r = await execCommand(command, root, 20_000, new AbortController().signal);
    assert.equal(r.code, 0, `打てていない: ${r.output}`);
    // **走った跡で見る。**終了コードだけだと、打てていないのに 0 が返る形を見逃す。
    assert.equal(await readFile(join(root, 'ran.txt'), 'utf8'), 'x');
  });
});
