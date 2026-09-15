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
  'linux-x64-cuda-ext', 'linux-x64-vulkan', 'win-x64', 'win-x64-cuda', 'win-x64-vulkan', 'mac-arm64',
];

/**
 * 組んだ先を作って、その中に node_modules を並べる。
 *
 * **組んだ先を渡す形にした。**片づけは、組んだ先の中でしか消さない
 * （手元の node_modules から typescript と playwright-core が消えたことがある）。
 */
async function modules(): Promise<{ dir: string; out: string }> {
  const out = await tempDir('aas-target-');
  const dir = join(out, 'app', 'node_modules');
  await mkdir(dir, { recursive: true });
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
  return { dir, out };
}

describe('配る先のものだけを残す', () => {
  test('**Windows むけなら、win-x64 と、その GPU 用（cuda・vulkan）が残る**', async () => {
    // GPU 用は `win-x64-` で始まる別のパッケージ。CPU の分だけ残すと、
    // RTX の機械でも CPU で回る（実機でそうなった）。
    const { dir, out } = await modules();
    await pruneForTarget(dir, 'win-x64', () => {}, out);
    const left = (await readdir(join(dir, '@node-llama-cpp'))).sort();
    assert.deepEqual(left, ['win-x64', 'win-x64-cuda', 'win-x64-vulkan'], `残ったもの: ${left.join(',')}`);
  });

  test('**配る先そのものを、消さない**', async () => {
    // 当て推量が外れて win-x64 を消した。動かないものが出ていく。
    for (const target of PLATFORMS) {
      const { dir, out } = await modules();
      await pruneForTarget(dir, target, () => {}, out);
      const left = await readdir(join(dir, '@node-llama-cpp'));
      assert.ok(left.includes(target), `${target} むけなのに、${target} を消している`);
    }
  });

  test('本体（走らせる場所に依らないもの）は残す（対）', async () => {
    const { dir, out } = await modules();
    await pruneForTarget(dir, 'win-x64', () => {}, out);
    const left = await readdir(dir);
    assert.ok(left.includes('node-llama-cpp'), '本体まで消している');
  });

  test('開発でしか使わないものは落とす', async () => {
    const { dir, out } = await modules();
    await pruneForTarget(dir, 'win-x64', () => {}, out);
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

/**
 * `--node-exe` のとき、組んでいる機械の側を配る先にしていた。
 *
 * `--node-here` なら、いま動かしている Node がそのまま入るので、配る先は
 * この機械でよい。**`--node-exe` は違う。**渡されたのは別の機械むけの Node で、
 * そこが配る先。ここを一緒くたにしていたので、Linux で `--node-exe node.exe`
 * と組むと配る先が `linux-x64` になり、**`win-x64` を落として Linux の binary
 * だけを残した。**Windows で開いてもモデルを読めない。実測 811MB のうち、
 * win-x64 は 1 バイトも入っていなかった。
 */
describe('配る先を、渡された Node から決める', () => {
  test('MZ で始まるものは Windows', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { guessTarget } = await import('../scripts/bundle.mjs');
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-target-');
    const exe = join(dir, 'node.exe');
    await writeFile(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
    assert.equal(await guessTarget({ nodeExe: exe }), 'win-x64');
  });

  test('**読めないものは、決めない**', async () => {
    // 当て推量で消すと、要るものを消したものが黙って出ていく。
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { guessTarget } = await import('../scripts/bundle.mjs');
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-target2-');
    const odd = join(dir, 'node.bin');
    await writeFile(odd, 'これは実行ファイルではありません');
    assert.equal(await guessTarget({ nodeExe: odd }), undefined);
    assert.equal(await guessTarget({ nodeExe: join(dir, '無い') }), undefined);
    assert.equal(await guessTarget({}), undefined);
  });

  test('--node-here は、この機械（対）', async () => {
    // ここだけは当て推量ではない。いま動かしている Node がそのまま入る。
    const { guessTarget } = await import('../scripts/bundle.mjs');
    const got = await guessTarget({ nodeHere: true });
    assert.equal(got, `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`);
  });

  /**
   * **組んだ先の外は、片づけない。**
   *
   * 手元の `node_modules` から typescript・playwright-core・@types が消えた。
   * `npm run typecheck` も sweep も、そのあと走らなくなる。しかも黙って消えるので、
   * 次に `npm run check` を回して「飛ばしました」と出るまで気づけない。
   * どの道でそうなったのかは掴めていない（同じ手順で再現しない）ので、
   * **起きても壊れない形**にしてある。
   */
  test('**組んだ先の外を渡されたら、消さずに投げる**', async () => {
    const { dir } = await modules();
    const other = await tempDir('aas-other-out-');
    await assert.rejects(
      () => pruneForTarget(dir, 'win-x64', () => {}, other),
      /組んだ先の外/,
      '外を渡しても片づけてしまう',
    );
    // 投げる前に一つも消していないこと。
    const left = await readdir(dir);
    assert.ok(left.includes('typescript'), '投げる前に消している');
  });

  test('組んだ先そのものを渡されても、投げる（対）', async () => {
    // `out` と同じ場所を渡すのは、`app/node_modules` の組み立てを間違えた形。
    const { out } = await modules();
    await assert.rejects(() => pruneForTarget(out, 'win-x64', () => {}, out), /組んだ先の外/);
  });
});
