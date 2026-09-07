/**
 * 配る先のものだけを入れる。
 *
 * `@node-llama-cpp` は走らせる場所ごとに別のパッケージで入る
 * （linux の CUDA・Vulkan・arm、win、mac …）。開発機は Linux なので、
 * **Windows むけに組んでも Linux の binary が全部入っていた。**
 * 実測 930MB。うち Windows に要るのは 46MB だけ。
 *
 * 直す途中で、**当て推量が外れて `win-x64` を消した**。渡された zip の
 * ファイル名から配る先を読んでいたが、名前を変えて渡すと外れる。
 * そのまま気づかず出れば、Windows で動かないものを配ることになる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { pruneForTarget, targetFromNodeDir } from '../scripts/bundle.mjs';

const PLATFORMS = [
  'linux-arm64', 'linux-armv7l', 'linux-x64', 'linux-x64-cuda',
  'linux-x64-cuda-ext', 'linux-x64-vulkan', 'win-x64', 'mac-arm64',
];

async function modules(): Promise<string> {
  const dir = await tempDir('aas-target-');
  for (const p of PLATFORMS) {
    await mkdir(join(dir, '@node-llama-cpp', p), { recursive: true });
    await writeFile(join(dir, '@node-llama-cpp', p, 'binary'), 'x'.repeat(100), 'utf8');
  }
  for (const dev of ['typescript', 'playwright-core']) {
    await mkdir(join(dir, dev), { recursive: true });
    await writeFile(join(dir, dev, 'x.js'), 'x', 'utf8');
  }
  await mkdir(join(dir, 'node-llama-cpp'), { recursive: true });
  await writeFile(join(dir, 'node-llama-cpp', 'x.js'), 'x', 'utf8');
  return dir;
}

describe('配る先のものだけを残す', () => {
  test('**Windows むけなら、win-x64 が残る**', async () => {
    const dir = await modules();
    await pruneForTarget(dir, 'win-x64', () => {});
    const left = (await readdir(join(dir, '@node-llama-cpp'))).sort();
    assert.deepEqual(left, ['win-x64'], `残ったもの: ${left.join(',')}`);
  });

  test('**配る先そのものを、消さない**', async () => {
    // 当て推量が外れて win-x64 を消した。動かないものが出ていく。
    for (const target of PLATFORMS) {
      const dir = await modules();
      await pruneForTarget(dir, target, () => {});
      const left = await readdir(join(dir, '@node-llama-cpp'));
      assert.ok(left.includes(target), `${target} むけなのに、${target} を消している`);
    }
  });

  test('本体（走らせる場所に依らないもの）は残す（対）', async () => {
    const dir = await modules();
    await pruneForTarget(dir, 'win-x64', () => {});
    const left = await readdir(dir);
    assert.ok(left.includes('node-llama-cpp'), '本体まで消している');
  });

  test('開発でしか使わないものは落とす', async () => {
    const dir = await modules();
    await pruneForTarget(dir, 'win-x64', () => {});
    const left = await readdir(dir);
    assert.ok(!left.includes('typescript'), 'typescript が残っている');
    assert.ok(!left.includes('playwright-core'), 'playwright-core が残っている');
  });

  test('**配る先は、入れた Node そのものから決める**', () => {
    // zip のファイル名から読んでいたので、名前を変えて渡すと外れた。
    assert.equal(targetFromNodeDir('node-v22.22.2-win-x64'), 'win-x64');
    assert.equal(targetFromNodeDir('node-v22.22.2-linux-x64'), 'linux-x64');
    assert.equal(targetFromNodeDir('node-v20.0.0-darwin-arm64'), 'darwin-arm64');
  });

  test('読めない名前なら、決めない（対）', () => {
    // **決まらないときに当てない。**当てて外すと、要るものを消す。
    assert.equal(targetFromNodeDir('node-win.zip'), undefined);
    assert.equal(targetFromNodeDir('なにこれ'), undefined);
  });
});
