/**
 * どの OS でも、ここで試す。
 *
 * `process.platform` を直に見ていたので、Linux で走らせている限り
 * Windows と macOS の分岐が一度も通らなかった。**配ってから初めて動く**形で、
 * 「こちらでは動くが向こうでは動かない」の温床になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openerFor, revealCommand } from '../src/core/opener.ts';
import { caseBlind } from '../src/core/harness-setup.ts';
import { Harness } from '../src/harness/harness.ts';
import { protectedPaths } from '../src/harness/builtin-rules.ts';
import { AuditLog } from '../src/harness/audit.ts';
import { writeFileTool } from '../src/agent/tools/fs.ts';
import { tempDir } from './tmp.ts';

describe('ブラウザを開く命令', () => {
  test('Windows', () => { assert.equal(openerFor('win32'), 'explorer'); });
  test('macOS', () => { assert.equal(openerFor('darwin'), 'open'); });
  test('Linux', () => { assert.equal(openerFor('linux'), 'xdg-open'); });
  test('知らない OS でも、何かは返す（黙って undefined を渡さない）', () => {
    assert.equal(typeof openerFor('freebsd' as NodeJS.Platform), 'string');
  });
});

describe('ファイルやフォルダを OS で開いて見せる命令', () => {
  test('Windows: ファイルは選んだ状態で、フォルダはそのまま', () => {
    assert.deepEqual(revealCommand('win32', 'C:\\work\\a.txt', false), { command: 'explorer', args: ['/select,C:\\work\\a.txt'] });
    assert.deepEqual(revealCommand('win32', 'C:\\work', true), { command: 'explorer', args: ['C:\\work'] });
  });
  test('macOS: ファイルは -R で、フォルダはそのまま', () => {
    assert.deepEqual(revealCommand('darwin', '/w/a.txt', false), { command: 'open', args: ['-R', '/w/a.txt'] });
    assert.deepEqual(revealCommand('darwin', '/w', true), { command: 'open', args: ['/w'] });
  });
  test('Linux: ファイルなら、その在るフォルダを開く', () => {
    assert.deepEqual(revealCommand('linux', '/w/a.txt', false), { command: 'xdg-open', args: ['/w'] });
    assert.deepEqual(revealCommand('linux', '/w', true), { command: 'xdg-open', args: ['/w'] });
  });
});

describe('大小を区別しないファイルシステムか', () => {
  /**
   * ここが違うと、守る対象が OS で変わる。Windows では `.ENV` も `.env` として
   * 守るが、その分岐は Linux では一度も通らなかった。
   */
  test('Windows と macOS は区別しない', () => {
    assert.equal(caseBlind('win32'), true);
    assert.equal(caseBlind('darwin'), true);
  });
  test('Linux は区別する（対）', () => {
    assert.equal(caseBlind('linux'), false);
  });
});

describe('Windows として組んだ検問所を、Linux で試す', () => {
  /**
   * ここは配るまで一度も通らない分岐だった。**守りすぎても困る。**
   * 広く当たりすぎると、Windows でだけ普通のファイルが書けなくなる。
   */
  const guard = (platform: NodeJS.Platform) => new Harness({
    rules: [protectedPaths(
      ['.env', '.env.*', '**/*.lock', '.git/**', '**/id_rsa', '**/*.pem', '**/credentials*'],
      { nocase: caseBlind(platform) },
    )],
    audit: new AuditLog(),
  });

  const canWrite = async (platform: NodeJS.Platform, path: string) => {
    const root = await tempDir('aas-os-');
    const r = await guard(platform).wrap(writeFileTool, () => '').run({ path, content: 'x' }, {
      root, signal: new AbortController().signal, approve: async () => true,
    });
    return !r.isError;
  };

  test('**Windows では、大文字の .ENV も守る**', async () => {
    assert.equal(await canWrite('win32', '.ENV'), false, '大文字だと素通りしている');
    assert.equal(await canWrite('win32', '.env'), false);
  });

  test('Linux は大文字を別物として扱う（対）', async () => {
    assert.equal(await canWrite('linux', '.env'), false);
    assert.equal(await canWrite('linux', '.ENV'), true, 'Linux では別のファイル');
  });

  test('**守りすぎない。普通のファイルは Windows でも書ける**', async () => {
    for (const path of [
      'src/index.ts', 'README.md', 'ENVIRONMENT.md', 'src/env-view.ts',
      'docs/environment.md', 'src/lockfile-view.ts',
    ]) {
      assert.equal(await canWrite('win32', path), true, `Windows でだけ書けない: ${path}`);
    }
  });
});
