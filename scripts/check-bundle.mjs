/*
 * 配る形のまま、全部のテストを回す。
 *
 * **ここまで、配る形で動かしたことが一度も無かった。**組んで、Releases に
 * 置いて、開いてもらっていた。手元では通るのに開くと動かない、が続いた元が
 * これ。手で組んで手で回したときは 17 件落ちた（そのときだけ）。
 *
 * 一つの命令にする。手順が長いと、忙しいときに飛ばす。
 *
 *   npm run check:bundle
 *
 * 組むのは**この機械むけ**（--node-here）。配る先は Windows なので、これで
 * Windows を確かめたことにはならない。確かめられるのは「配る形に組んだとき、
 * 中身が欠けていないか」まで。欠けは実際に起きている（Windows むけに組んだ
 * のに Windows の binary が入っていなかった）。
 */
import { spawn } from 'node:child_process';
import { rm, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'check-bundle');

/** 走らせて、終わりを待つ。落ちたら、そこで止める。 */
function run(cmd, args, opts = {}) {
  return new Promise((ok, ng) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', ng);
    p.on('exit', (code) => (code === 0 ? ok() : ng(new Error(`${cmd} が ${code} で終わりました`))));
  });
}

console.log('== 配る形に組む');
await rm(out, { recursive: true, force: true });
await run(process.execPath, [join(root, 'scripts', 'bundle.mjs'), '--node-here', '--out', out]);

// 同梱した Node を使う。**入れた側の Node を使わない。**それでは、配った先で
// 同梱の Node が動くかどうかを確かめたことにならない。
const node = join(out, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
if (!(await stat(node).catch(() => undefined))) {
  console.error(`同梱の Node が見つかりません: ${node}`);
  process.exit(1);
}

console.log('\n== その中で、全部のテストを回す');
const app = join(out, 'app');
await run(node, [join(app, 'scripts', 'run-tests.mjs')], { cwd: app });

/*
 * ここから、**組んだものを実際に起こして触る。**
 *
 * 試験が通ることと、開いて使えることは別。開いても何も出ない、を
 * 配ってから見つけてもらっていたので、ここで起こして押すところまでやる。
 */
/*
 * **モデルを置いてから起こす。**
 *
 * 置いていない状態だと、送ったときに断られる所までしか見えない。
 * それでは「配る形で1ターン通せた」と言えない。重みは乱数の小さなものを
 * ここで組む（`tiny-gguf.mjs`）。答えの中身は見ない。道が通っているかだけ。
 */
console.log('\n== モデルを置く（重みは乱数の小さなもの）');
const models = join(out, 'data', 'models');
await mkdir(models, { recursive: true });
await run(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), join(models, 'tiny.gguf')]);

console.log('\n== その中の画面を起こして、通す');
/*
 * **決まった口を取り合わない。**
 *
 * 既定の口（4174）で起こしていたので、前に起こしたものが残っていると
 * 「既に使われています」で終わり、ここは「画面が 1 で終わりました」としか
 * 言わなかった。**本体が言っていることを、そのまま出す。**
 * 口は空いているものを使う（AAS_UI_PORT=0）。
 */
const ui = spawn(node, [join(app, 'scripts', 'run.mjs'), 'ui'], {
  cwd: app, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, AAS_UI_PORT: '0' },
});
let url = '';
try {
  let seen = '';
  url = await new Promise((ok, ng) => {
    const wait = setTimeout(() => ng(new Error('画面が出てきません')), 60_000);
    ui.stdout.on('data', (b) => {
      seen += String(b);
      const m = /(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(seen);
      if (m) { clearTimeout(wait); ok(m[1]); }
    });
    ui.on('exit', (c) => {
      clearTimeout(wait);
      ng(new Error(`画面が ${c} で終わりました:\n${seen.trim() || '（何も言っていません）'}`));
    });
  });
  console.log(`  画面: ${url}`);

  console.log('\n== 起こした画面に、smoke を通す');
  await run(node, [join(app, 'scripts', 'smoke.mjs')], { cwd: app });

  console.log('\n== 起こした画面に、sweep を通す');
  // sweep は Chromium が要る。無い機械では回せないので、そのときはそう言う。
  // **黙って飛ばさない。**通ったのか、やらなかったのかが分からなくなる。
  // モデルは置いてある。`--no-model` を付けると、送りが断られるのを
  // 正しい振る舞いとして数えてしまい、**送る所を一度も押さないまま通る。**
  await run(process.execPath, [join(root, 'scripts', 'sweep.mjs'), url], { cwd: root })
    .catch((e) => { throw new Error(`sweep が通りませんでした: ${e.message}`); });
} finally {
  ui.kill();
}

console.log('\n== 配る形のまま通りました');
console.log(`  組んだ場所: ${out}`);
console.log('  ここで確かめたのは、この機械むけに組んだ中身までです。');
console.log('  配る先（Windows）で開いたわけではありません。');
