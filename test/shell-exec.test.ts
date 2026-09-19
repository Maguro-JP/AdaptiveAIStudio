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
import { execCommand, spawnPlan, spawnCall, killPlan, decodeOutput } from '../src/agent/shell-exec.ts';

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
 * Windows 側の分岐を見る。
 *
 * 手元も CI も Linux だと、win32 の分岐は一度も実行されないまま配られる。
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

describe('cmd の出力が CP932 でも化けない', () => {
  // Windows の cmd は日本語だと CP932 を吐く。ここでは同じバイト列を
  // 1バイトずつ書く子を立てて、必ずその形にする。
  test('CP932 の出力を、そのまま日本語で受け取る', async () => {
    const root = await tempDir('aas-cp932-');
    await writeFile(join(root, 'cp932.mjs'), `
      const bytes = [0x82,0xa0,0x82,0xa2,0x82,0xa4,0x0d,0x0a]; // あいう\\r\\n
      for (const b of bytes) process.stdout.write(Buffer.from([b]));
    `);
    const r = await execCommand('node cp932.mjs', root, 10_000, new AbortController().signal);
    assert.equal(r.code, 0);
    assert.match(r.output, /あいう/);
    assert.doesNotMatch(r.output, /�/);
  });

  test('UTF-8 の出力は UTF-8 のまま（対）', async () => {
    const root = await tempDir('aas-utf8-');
    await writeFile(join(root, 'u.mjs'), `process.stdout.write('あいう\\n');`);
    const r = await execCommand('node u.mjs', root, 10_000, new AbortController().signal);
    assert.match(r.output, /あいう/);
  });

  test('末尾だけ残すとき、先頭の切れ端で全体を化けさせない', () => {
    // 「あいう」の先頭1バイトを落とした形。頭だけ捨てて残りを読む。
    const raw = Buffer.from('あいう', 'utf8').subarray(1);
    assert.equal(decodeOutput(raw), 'いう');
  });
});

/**
 * **トークンを、走らせたものから読めないようにする。**
 *
 * `spawn` に `env` を渡していなかったので、親の環境変数がそのまま全部子へ
 * 行っていた。許可している命令に `echo` と `cat` が在るので、
 * **`echo $GITHUB_TOKEN` 一つでトークンが読める。**出力はモデルの履歴と会話の
 * 記録に入るので、遠くのモデルを候補に入れていれば、そこへも出て行く。
 *
 * 走らせ方は `node -e`（どの OS でも同じに書ける）。`echo` は殻ごとに書き方が
 * 違うので、**走らせる場所で結果が変わる試験**になってしまう。
 */
describe('トークンを子へ渡さない', () => {
  test('**名前がトークンらしい環境変数は、走らせたものから読めない**', async () => {
    const root = await tempDir('aas-exec-secret-');
    process.env.AAS_TEST_TOKEN = 'ghp_should_not_leak';
    try {
      const r = await execCommand(
        `node -e "console.log(process.env.AAS_TEST_TOKEN ?? 'none')"`,
        root, 30_000, new AbortController().signal,
      );
      assert.equal(r.output.trim(), 'none', `走らせたものからトークンが読める: ${r.output}`);
      assert.equal(r.output.includes('ghp_should_not_leak'), false, 'トークンが出力に出ている');
    } finally {
      delete process.env.AAS_TEST_TOKEN;
      await cleanup(root);
    }
  });

  test('トークンらしくない環境変数は、これまでどおり渡す（対）', async () => {
    const root = await tempDir('aas-exec-plain-');
    process.env.AAS_TEST_PLAIN = 'ok';
    try {
      const r = await execCommand(
        `node -e "console.log(process.env.AAS_TEST_PLAIN ?? 'none')"`,
        root, 30_000, new AbortController().signal,
      );
      assert.equal(r.output.trim(), 'ok', `渡すべきものが渡っていない: ${r.output}`);
    } finally {
      delete process.env.AAS_TEST_PLAIN;
      await cleanup(root);
    }
  });
});

/**
 * **どちらの道でも、渡す環境を絞る。**
 *
 * 殻を使う道（Windows）と使わない道（それ以外）で `spawn` の呼び方が違うので、
 * 片方にだけ `env` を渡しても、走らせている機械の道しか通らず気づけない
 * （linux では Windows の道を一度も通らない）。両方まとめて見る。
 */
describe('spawn へ渡すもの', () => {
  const env = { PATH: '/usr/bin' };

  test('**殻を使う道（Windows）でも env を渡す**', () => {
    const call = spawnCall(spawnPlan('npm test', 'win32'), 'C:/work', env);
    assert.equal(call.args, undefined, '殻を使う道で args を渡している');
    assert.deepEqual(call.options.env, env, '殻を使う道で env を渡していない');
    assert.equal(call.options.shell, true);
  });

  test('**殻を使わない道でも env を渡す**', () => {
    const call = spawnCall(spawnPlan('npm test', 'linux'), '/work', env);
    assert.deepEqual(call.args, ['-c', 'npm test']);
    assert.deepEqual(call.options.env, env, '殻を使わない道で env を渡していない');
  });
});
