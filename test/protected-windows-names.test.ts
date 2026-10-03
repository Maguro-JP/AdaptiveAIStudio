/**
 * Windows で動くときだけ、保護された道を Windows が作る名前に揃えて照らす（`src/core/harness-setup.ts` のつなぎ）。
 *
 * 規則そのものは `test/guard-gaps.test.ts` で見ている。ここは組み立てで win32 のときに入り、それ以外では入らないことを見る
 * （つなぎを消しても規則の試験は通るので、別に見る）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-protected-windows-state-');
const { buildHarness } = await import('../src/core/harness-setup.ts');
const { writeFileTool } = await import('../src/agent/tools/fs.ts');

async function tryWrite(platform: NodeJS.Platform): Promise<string> {
  const root = await tempDir('aas-protected-windows-');
  const harness = await buildHarness({ agent: { root }, harness: { readBeforeWrite: false } } as never, undefined, undefined, platform);
  const tool = harness.wrap(writeFileTool, () => '');
  return (await tool.run({ path: '.env ', content: 'X' }, { root, signal: new AbortController().signal, approve: async () => true })).content;
}

describe('末尾に空白のある .env', () => {
  test('Windows では止める（Windows は末尾の空白を落として .env を作る）', async () => {
    assert.match(await tryWrite('win32'), /BLOCKED by protected-paths/);
  });
  test('Linux では止めない（`.env ` は .env とは別の名前）', async () => {
    assert.doesNotMatch(await tryWrite('linux'), /protected-paths/);
  });
});
