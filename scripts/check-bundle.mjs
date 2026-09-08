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
import { rm, stat } from 'node:fs/promises';
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
console.log('\n== その中の画面を起こして、通す');
const ui = spawn(node, [join(app, 'scripts', 'run.mjs'), 'ui'], {
  cwd: app, stdio: ['ignore', 'pipe', 'inherit'],
});
let url = '';
try {
  url = await new Promise((ok, ng) => {
    const wait = setTimeout(() => ng(new Error('画面が出てきません')), 60_000);
    let seen = '';
    ui.stdout.on('data', (b) => {
      seen += String(b);
      const m = /(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(seen);
      if (m) { clearTimeout(wait); ok(m[1]); }
    });
    ui.on('exit', (c) => { clearTimeout(wait); ng(new Error(`画面が ${c} で終わりました`)); });
  });
  console.log(`  画面: ${url}`);

  console.log('\n== 起こした画面に、smoke を通す');
  await run(node, [join(app, 'scripts', 'smoke.mjs')], { cwd: app });

  console.log('\n== 起こした画面に、sweep を通す');
  // sweep は Chromium が要る。無い機械では回せないので、そのときはそう言う。
  // **黙って飛ばさない。**通ったのか、やらなかったのかが分からなくなる。
  await run(process.execPath, [join(root, 'scripts', 'sweep.mjs'), url, '--no-model'], { cwd: root })
    .catch((e) => { throw new Error(`sweep が通りませんでした: ${e.message}`); });
} finally {
  ui.kill();
}

console.log('\n== 配る形のまま通りました');
console.log(`  組んだ場所: ${out}`);
console.log('  ここで確かめたのは、この機械むけに組んだ中身までです。');
console.log('  配る先（Windows）で開いたわけではありません。');
