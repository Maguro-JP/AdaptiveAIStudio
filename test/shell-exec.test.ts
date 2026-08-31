/**
 * コマンド実行の検証。
 * 上限で打ち切ったとき、殻の下の本体まで止まることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { tempDir, cleanup } from './tmp.ts';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execCommand, spawnPlan, killPlan } from '../src/agent/shell-exec.ts';

/**
 * 打ち切られた後も生きていれば、印を書き足してしまう子。
 * 置き場は環境変数で渡す。Windows のパスは引数に載せると殻の解釈で崩れる。
 */
const SURVIVOR = `
import { writeFileSync } from 'node:fs';
setTimeout(() => writeFileSync(process.env.MARKER, 'survived'), 1500);
setTimeout(() => {}, 30_000);
`;

describe('execCommand', () => {
  test('時間上限で打ち切ると、その下の処理も止まる', async () => {
    const root = await tempDir('aas-exec-');
    try {
      await writeFile(join(root, 'survivor.mjs'), SURVIVOR);
      const marker = join(root, 'marker.txt');

      process.env.MARKER = marker;
      const started = Date.now();
      const r = await execCommand('node survivor.mjs', root, 300, new AbortController().signal);
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 10_000, '上限で戻ること');

      // 打ち切った後も生きていれば、この間に印が書かれる。
      await delay(2500);
      assert.equal(
        await readFile(marker, 'utf8').catch(() => null), null,
        '打ち切った処理が生き残って走り続けている',
      );
    } finally {
      await cleanup(root);
    }
  });

  test('中断でも同じように止まる', async () => {
    const root = await tempDir('aas-exec-');
    try {
      await writeFile(join(root, 'survivor.mjs'), SURVIVOR);
      const marker = join(root, 'marker.txt');
      process.env.MARKER = marker;
      const ac = new AbortController();
      const run = execCommand('node survivor.mjs', root, 30_000, ac.signal);
      await delay(200);
      ac.abort();
      const r = await run;
      assert.equal(r.aborted, true);

      await delay(2500);
      assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
    } finally {
      await cleanup(root);
    }
  });

  test('通常の終了は今までどおり結果を返す', async () => {
    const root = await tempDir('aas-exec-');
    try {
      const r = await execCommand('echo hello', root, 10_000, new AbortController().signal);
      assert.equal(r.code, 0);
      assert.equal(r.timedOut, false);
      assert.match(r.output, /hello/);
    } finally {
      await cleanup(root);
    }
  });
});

/**
 * Windows 側の枝の検査。
 *
 * 手元も CI も Linux だと、win32 の枝は一度も実行されないまま配られる。
 * 実際に「Linux では通るが Windows では落ちる」を踏んだので、
 * 組み立ての内容だけでも、どちらの側も見ておく。
 * ここが通っても Windows で動く証明にはならない。
 * 証明できるのは「組み立てを間違えていないこと」だけ。
 */
describe('環境ごとの組み立て', () => {
  test('Windows は cmd.exe に任せる', () => {
    const p = spawnPlan('npm test', 'win32');
    assert.equal(p.shell, true, 'cmd.exe を通していない');
    assert.equal(p.file, 'npm test', '殻に渡す文字列が組み立てられていない');
    assert.equal(p.detached, false, 'Windows に処理群は無い');
  });

  test('Windows 以外は処理群を作る', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const p = spawnPlan('npm test', platform);
      assert.equal(p.file, '/bin/sh', platform);
      assert.deepEqual(p.args, ['-c', 'npm test'], platform);
      // これが無いと、上限で打ち切っても殻の下の本体が生き残る
      assert.equal(p.detached, true, `${platform}: 処理群を作っていない`);
    }
  });

  test('Windows は木をたどって落とす', () => {
    const p = killPlan(1234, 'win32');
    assert.equal(p.command, 'taskkill');
    assert.ok(p.args.includes('/T'), '子孫まで落としていない');
    assert.ok(p.args.includes('/F'), '強制で落としていない');
    assert.ok(p.args.includes('1234'));
  });

  test('Windows 以外は処理群ごと落とす', () => {
    const p = killPlan(1234, 'linux');
    // 負の番号は「その処理群すべて」の意味。ここを正にすると殻しか死なない。
    assert.deepEqual(p.args, ['-TERM', '-1234']);
  });
});
