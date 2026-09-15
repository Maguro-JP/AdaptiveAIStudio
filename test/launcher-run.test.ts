/**
 * 入口を、Windows で実際に押す。
 *
 * ここまで入口（`launcher.cmd` / `app\start.cmd`）は**中身を読むだけ**だった
 * （`test/batch.test.ts`: 文字集合・括弧・goto の飛び先）。読める形をしている
 * ことは、**押したときに始まることを言わない。**利用者が最初に触るのはここで、
 * ここが開かなければ他の何が通っていても意味が無い。
 *
 * Windows の CI（`windows-latest`）はこの束を回すので、そこで**実際に走らせる。**
 * 別の仕事を足さないので、枠は増えない。
 *
 * linux では走らせられない。飛ばして、飛ばしたと言う（黙って通さない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installRoot } from '../src/core/home.ts';
import { tempDir } from './tmp.ts';

const onlyWindows = process.platform === 'win32'
  ? {}
  : { skip: 'cmd.exe が要ります（linux では中身の確かめだけ: test/batch.test.ts）' };

/**
 * バッチを走らせて、終わりまで待つ。
 *
 * **入力を閉じてから待つ。**入口は最後に `pause` で止まる（人が読む間を置く）。
 * 閉じないと、ここで永遠に待つ。
 */
function runBatch(
  file: string, args: string[], cwd: string, home: string,
): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const child = spawn(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', file, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // **リポジトリの中に跡を残させない。**根は仮の場所へ逃がす
      // （走らせた跡が残ると、次の人が消すことになる）。
      env: { ...process.env, AAS_HOME: home, AAS_STATE_DIR: join(home, 'state') },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stdin.end();
    // 上限で諦める。返らないのも不具合なので、そう分かる形で返す。
    const giveUp = setTimeout(() => { child.kill(); ok({ code: -1, out: `${out}\n（返ってきません）` }); }, 180_000);
    giveUp.unref?.();
    child.on('close', (code) => { clearTimeout(giveUp); ok({ code: code ?? -1, out }); });
  });
}

describe('入口を、実際に押す', () => {
  /*
   * 日本語は CP932 で出るので、ここで読むと化ける。
   * **見るのは ASCII の所だけ**にする（化けても意味が変わらない）。
   */
  test('**`start.cmd <仕事>` で、その仕事が走る**', onlyWindows, async () => {
    const got = await runBatch('start.cmd', ['models'], installRoot(), await tempDir('aas-run-home-'));
    assert.equal(got.code, 0, `終わり方が違う: ${got.code}\n${got.out.slice(-800)}`);
    // 入口自身が出す行（Node を見つけたこと）。
    assert.match(got.out, /Node v?\d+\./, `Node を見つけていない:\n${got.out.slice(0, 600)}`);
    // 仕事の側が出す行。ここまで来て初めて「押せば動く」。
    assert.match(got.out, /AdaptiveAIStudio/, `仕事が走っていない:\n${got.out.slice(0, 800)}`);
    assert.match(got.out, /inproc/, `モデルの入口まで来ていない:\n${got.out.slice(0, 800)}`);
  });

  test('**ZIP の中から押されたら、取り出してくださいと言って止まる**', onlyWindows, async () => {
    // `app\start.cmd` が無い形（ZIP の中から押すと、これだけが temp へ出る）。
    const dir = await tempDir('aas-zip-');
    const at = join(dir, 'AdaptiveAIStudio.cmd');
    await copyFile(join(installRoot(), 'launcher.cmd'), at);
    const got = await runBatch('AdaptiveAIStudio.cmd', [], dir, join(dir, 'home'));
    assert.equal(got.code, 1, `止まっていない: ${got.code}\n${got.out.slice(-600)}`);
    assert.match(got.out, /AdaptiveAIStudio/, `何も言っていない:\n${got.out.slice(0, 600)}`);
    // 画面が閉じずに読める形（pause）で止まっていること。入力を閉じたので進む。
    assert.ok(got.out.length > 0, '何も出さずに閉じている');
  });

  test('**隣に app が在れば、入口は仕事を渡す**', onlyWindows, async () => {
    /*
     * 配る形と同じ並び（`AdaptiveAIStudio.cmd` の隣に `app\`）。
     * 中身は写さず、目当ての一行だけ置いて「渡したか」を見る（写すと 90MB 動く）。
     */
    const dir = await tempDir('aas-shape-');
    await copyFile(join(installRoot(), 'launcher.cmd'), join(dir, 'AdaptiveAIStudio.cmd'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'app'), { recursive: true });
    // CP932 で置く（本物と同じ作法）。中身は ASCII だけにする。
    await writeFile(join(dir, 'app', 'start.cmd'),
      '@echo off\r\necho HANDED %1\r\nexit /b 0\r\n', 'latin1');
    const got = await runBatch('AdaptiveAIStudio.cmd', ['doctor'], dir, join(dir, 'home'));
    assert.equal(got.code, 0, `${got.code}\n${got.out}`);
    assert.match(got.out, /HANDED doctor/, `仕事を渡していない:\n${got.out}`);
  });
});
