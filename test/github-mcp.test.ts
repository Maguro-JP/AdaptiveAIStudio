/**
 * GitHub に繋ぐ道具を、どうやって起こすか。
 *
 * ここまで `npx -y @modelcontextprotocol/server-github` と書いていた。
 * **入れた機械では、これは一度も動かない。**
 *
 *   ・`npx` は npm に付いてくる。入れる版に入れているのは `node` だけ
 *   ・`-y` は毎回ネットから取ってくる。会社の PC は外へ出られない
 *
 * つまり「GitHub と繋ぐ」は、画面に口があるだけだった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { githubLaunch, bundledGithubServer } from '../src/core/github-mcp.ts';

describe('GitHub に繋ぐ道具の起こし方', () => {
  test('同梱してあるなら、同梱の Node で直に起こす', async () => {
    // npx も npm も要らない。外へ出る必要もない。
    const got = githubLaunch({ bundled: '/somewhere/dist/index.js', node: '/app/runtime/node' });
    assert.equal(got.command, '/app/runtime/node');
    assert.deepEqual(got.args, ['/somewhere/dist/index.js']);
    assert.equal(got.why, undefined, '起こせるのに、起こせないと言っている');
  });

  test('同梱していなくても、npx があれば使う（作業コピー）', () => {
    const got = githubLaunch({ bundled: undefined, hasNpx: true });
    assert.equal(got.command, 'npx');
    assert.equal(got.why, undefined);
  });

  test('どちらも無いなら、無いと言う', () => {
    // **黙って繋がらないのが、いちばん困る。**
    const got = githubLaunch({ bundled: undefined, hasNpx: false });
    assert.ok(got.why, '起こせないのに、何も言っていない');
    assert.match(got.why, /見つかりません/);
  });

  test('置かれ方で見つける（in-process で判じない）', async () => {
    const app = await tempDir('aas-ghm-');
    const at = join(app, 'node_modules', '@modelcontextprotocol', 'server-github', 'dist');
    await mkdir(at, { recursive: true });
    await writeFile(join(at, 'index.js'), '// x');
    // src/core/ の二つ上が app/。そこから見る。
    const from = join(app, 'src', 'core');
    await mkdir(from, { recursive: true });
    assert.equal(bundledGithubServer(from), join(at, 'index.js'));
    // 無いところでは undefined（在ると嘘をつかない）。
    assert.equal(bundledGithubServer(join(await tempDir('aas-ghm2-'), 'src', 'core')), undefined);
  });
});
