/**
 * 持ち運び版を組み立てる。
 *
 * 何も入れられない機械（会社の PC など）で動かすための一式。
 * フォルダを置くだけで動き、外には何も残さない。
 *
 *   ・設定も記録もモデルも、このフォルダの中（.portable が目印）
 *   ・実行時の依存はゼロなので node_modules は要らない
 *   ・Node 自体も同梱できる（--node-zip で渡す）
 *
 * 使い方:
 *   node scripts/bundle.mjs --out dist/aas-portable [--node-here]
 *                           [--node-zip x.zip | --node-exe node.exe]
 *                           [--node-name node.bin]
 *                           [--src <中身のある場所>] [--version <版>]
 *
 * **--node-here がいちばん手軽。**いま自分を動かしている Node を
 * そのまま入れるので、取ってこなくてよい。網も CI も要らない。
 *
 * Node の zip をここで落としに行かないのは、**組み立てと取得を分ける**ため。
 * 取得は網の繋がる場所（CI）でやり、ここは置く仕事だけをする。
 * そうすると、この道具自体は網が無くても試せる。
 */
import { cp, mkdir, writeFile, rm, readFile, stat, chmod, readdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 中身（app/ に入るもの）。入れないものではなく、**入れるものを挙げる**。
 *
 * 利用者が開いて意味の分かるもの（入口・使い方・記録）は app の外に出す。
 * 開けた瞬間に「どれを押せばいいのか」が分かる形にするため。
 */
export const PAYLOAD = [
  'src',
  'scripts',
  'package.json',
  'aas.config.example.json',
  'start.cmd',
  'start.sh',
  'README.md',
  'docs',
  // 持ち運び先でも検査を回せるようにする。**これが入っていないと、
  // 何も入れられない機械で確かめる、という目的そのものが果たせない。**
  'test',
  'tsconfig.json',
  // 型検査だけは devDependency（typescript）が要る。網の無い場所では
  // npm install できないので、入れておく。中身は素の JS で、機械に依らない。
  'node_modules',
];

/**
 * 中でいちばん深いものの、許す長さ。
 *
 * Windows は道の全体が 260 文字を超えると開けない。bundle の中は
 * `app/node_modules/node-llama-cpp/dist/...` が深く、150 文字ほどある。
 * **展開先が長いと、展開の途中で警告が出て、途中までしか出てこない。**
 * 利用者の機械で実際に出た。
 *
 * ここを超えたら組み立てを止める。**気づけるのは組むときだけ**で、
 * 落ちるのは利用者の展開のときだから。
 */
export const DEPTH_BUDGET = 160;

/** 中でいちばん深いもの（根からの相対）。 */
export async function deepest(dir) {
  let best = { rel: '', length: 0 };
  for (const name of await readdir(dir, { recursive: true })) {
    const rel = String(name);
    if (rel.length > best.length) best = { rel, length: rel.length };
  }
  return best;
}

/**
 * 要らないものを落とす。
 *
 * `.map` は、書いた側が元の行を辿るためのもの。動かすのには要らない。
 * 610 個・4MB あり、クラウドドライブへ置くときの数としても効く。
 *
 * 型の定義（`.d.ts`）と、抱えている試験用のもの（vitest など）も落とす。
 * **動かすのに要らないうえ、道をいちばん深くしているのがこれ。**
 * Windows の置き場所は 260 文字で、そのうち中身に使えるのは 107 文字しか
 * 残らない（一番深いものが 153 文字あった）。深い所へ入れると、
 * **入れた時点で失敗する。**
 */
const DROP_DIRS = [
  // node-llama-cpp が抱えている試験用のもの。動かすときには通らない。
  'vitest', '@vitest', 'vite', '@vitest+mocker',
  'tinybench', 'tinypool', 'tinyspy', 'chai', 'loupe', 'pathval',
];

function isDropDir(name) {
  return DROP_DIRS.some((d) => name === d || name.startsWith(`${d}@`) || name.startsWith(`${d}+`));
}

async function pruneExtras(dir, log) {
  let maps = 0;
  let types = 0;
  for (const name of await readdir(dir, { recursive: true })) {
    const rel = String(name);
    if (rel.endsWith('.map')) { await unlink(join(dir, rel)); maps += 1; continue; }
    if (/\.d\.(ts|cts|mts)$/.test(rel)) { await unlink(join(dir, rel)); types += 1; }
  }
  if (maps > 0) log(`  落とした: ${maps} 個の .map（動かすのには要りません）`);
  if (types > 0) log(`  落とした: ${types} 個の型定義（動かすのには要りません）`);

  // .pnpm の下に、試験用のものが丸ごと入っている。**そこが一番深い。**
  // ここへ渡ってくる dir が app/node_modules そのもの。
  const pnpm = join(dir, '.pnpm');
  let packs = 0;
  for (const name of await readdir(pnpm).catch(() => [])) {
    if (!isDropDir(String(name).split('@')[0] || String(name)) && !isDropDir(String(name))) continue;
    await rm(join(pnpm, String(name)), { recursive: true, force: true });
    packs += 1;
  }
  if (packs > 0) log(`  落とした: ${packs} 個の試験用のもの（動かすのには要りません）`);
}

/** package.json の版。--version を渡さなかったときの控え。 */
function pkgVersion(srcRoot) {
  try {
    return JSON.parse(readFileSync(join(srcRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

/**
 * --version が無いときの版。
 *
 * package.json の `0.1.0` だけを書くと、**手元で組んだものが全部同じ版**になる。
 * 直したはずの不具合が直っていないように見えたとき、どの中身で組んだかを
 * 辿れない。git に訊けるなら、短い印と「未コミットの変更あり」まで足す。
 * git に訊けない場所（bundleからbundle を組む等）では package.json の版だけ。
 */
export function guessVersion(srcRoot) {
  const base = pkgVersion(srcRoot);
  try {
    const opts = { cwd: srcRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const id = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    if (!id) return base;
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim().length > 0;
    return `${base}+${id}${dirty ? '（未コミットの変更あり）' : ''}`;
  } catch {
    return base;
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/** 中身を並べる。試験から呼べるように、副作用を out だけに閉じる。 */
/**
 * 製品の形に組み立てる。
 *
 *   AdaptiveAIStudio\
 *     AdaptiveAIStudio.cmd   押せばいい入口。これ以外は触らなくてよい
 *     README.txt             使い方（1枚）
 *     app\                  中身
 *     runtime\node.exe      同梱の Node
 *     data\                 記録・モデル・実行ファイル（動かすと出来る）
 *     VERSION                どの版か
 *     .portable              持ち運びの目印
 *
 * 開発中の作業場をそのまま渡すと、利用者は src と node_modules と
 * tsconfig.json を同じ高さで見ることになる。どれを押せばいいか分からない。
 * **触ってよいものだけを表に出す。**
 */
export async function bundle({
  out, nodeZip, nodeExe, nodeHere, srcRoot = root, version, log = () => {},
  // 同梱する Node をどの名前で置くか。既定は node.exe（何も変わらない）。
  //
  // node.bin にできるようにしてあるのは、会社のクラウドドライブが
  // **名前を見て** .exe を落とすため（Z: で実測。.bin なら 92,534,088
  // バイトそのまま書けた）。中身は同じで、名前だけが違う。
  // cmd.exe は PATHEXT に載っていれば拡張子を問わず実行するので、
  // 呼ぶ側は何も変えなくてよい。
  nodeName,
}) {
  await rm(out, { recursive: true, force: true });
  const app = join(out, 'app');
  await mkdir(app, { recursive: true });

  for (const item of PAYLOAD) {
    const from = join(srcRoot, item);
    try {
      await stat(from);
    } catch {
      log(`  ない: ${item}（飛ばします）`);
      continue;
    }
    await cp(from, join(app, item), { recursive: true });
    log(`  入れた: app/${item}`);
  }

  const modules = join(app, 'node_modules');
  // **握り潰さない。**片づけの中で転ぶと、黙って片づけごと止まる
  // （実際にそうなって、落とすはずのものが全部残った）。無いのは正常、
  // 転んだのは異常。分けて扱う。
  if (await stat(modules).then(() => true).catch(() => false)) {
    try {
      await pruneExtras(modules, log);
    } catch (e) {
      log(`  片づけで転びました: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  // 入口。押せばいいものが一つだけ表にある形にする。
  await writeFile(join(out, 'AdaptiveAIStudio.cmd'),
    ['@echo off', 'call "%~dp0app\\start.cmd" %*'].join('\r\n') + '\r\n', 'utf8');
  log('  置いた: AdaptiveAIStudio.cmd');

  // 展開先に、あと何文字使えるか。**利用者が展開する前に読む所へ書く。**
  // Windows は道の全体が 260 文字を超えると開けない。
  const deep = await deepest(out);
  const roomForFolder = (260 - 1) - 1 - deep.length;

  // 名前は普通のプログラムの作法に合わせる（README / VERSION）。
  // 中身は利用者の言語で書く。**名前は機械と慣習、中身は人。**
  await writeFile(join(out, 'README.txt'),
    [
      'AdaptiveAIStudio',
      '',
      '  AdaptiveAIStudio.cmd をダブルクリックしてください。',
      '',
      '置く場所',
      '',
      `  この AdaptiveAIStudio フォルダの道は、${roomForFolder} 文字までにしてください。`,
      '  Windows は道（パス）が 260 文字を超えると開けません。',
      '  長い所へ展開すると、途中で警告が出て、途中までしか出てきません。',
      '',
      '    よい例   Z:\\AdaptiveAIStudio                （19 文字）',
      '    だめな例 Z:\\…\\AdaptiveAIStudio-portable-noexe\\AdaptiveAIStudio',
      '',
      '  ZIP を右クリック→すべて展開 のとき、展開先の欄の後ろに',
      '  ZIP と同じ名前のフォルダが足されます。それを消してください。',
      '  二重になるだけで 49 文字使います。',
      '',
      '  展開したあとに、フォルダごと短い所へ移しても直ります。',
      '  いま足りているかは、入口の「3 困ったとき」で見られます。',
      '',
      'フォルダの中身',
      '',
      '  app        プログラム本体です。触らなくてかまいません。',
      '  runtime    同梱の Node です。この PC には何も入れていません。',
      '  data       設定・記録・モデルが入ります（動かすと出来ます）。',
      '',
      'この PC には何も残りません。このフォルダごと削除すれば、跡形もなくなります。',
      '',
      'いまの版は VERSION に書いてあります。',
      '新しくするときは、入口の「2 新しくする」を選んでください。',
    ].join('\r\n') + '\r\n', 'utf8');
  log(`  置いた: README.txt（置き場所は ${roomForFolder} 文字まで）`);

  // 版は独立した1ファイルにする。目印の中に混ぜると、読む側が
  // 目印を解釈しないと版が分からない。VERSION なら誰でも読める。
  const stamped = version ?? guessVersion(srcRoot);
  await writeFile(join(out, 'VERSION'), `${stamped}\r\n`, 'utf8');
  log(`  置いた: VERSION（${stamped}）`);

  // 持ち運びの目印。中身は要らない（在ることだけが意味を持つ）。
  // 名前に点を付けて、利用者が消す対象に見えないようにする。
  await writeFile(join(out, '.portable'),
    `built ${new Date().toISOString()}\r\n`, 'utf8');
  log('  置いた: .portable（持ち運びの目印）');

  // いま自分を動かしている Node を、そのまま入れる。
  // **これがいちばん確実で、いちばん安い。**取ってこなくてよいので
  // 網も要らず、CI も要らない。手元で `npm run bundle` を叩けば終わる。
  // ただし入るのはこの機械向けの Node なので、渡す先の OS が同じであること。
  const selfExe = nodeHere ? process.execPath : undefined;
  const exe = nodeExe ?? selfExe;

  if (exe) {
    // 用意用（bootstrap）は node.exe だけを落とす。npm は付いてこないが、
    // scripts/run.mjs があるので困らない。
    await mkdir(join(out, 'runtime'), { recursive: true });
    // Windows は node.exe、それ以外は node。渡す先で押せる名前にする。
    const name = nodeName ?? (exe.toLowerCase().endsWith('.exe') ? 'node.exe' : 'node');
    const dest = join(out, 'runtime', name);
    await cp(exe, dest);
    // fs.cp の mode は「写し方」の指定で、権限ではない。権限は別に付ける。
    await chmod(dest, 0o755).catch(() => { /* Windows では意味を持たない */ });
    log(`  入れた: runtime/${name}（同梱の Node${nodeHere ? '。いま動かしているもの' : ''}）`);
  } else if (nodeZip) {
    await mkdir(join(out, 'runtime'), { recursive: true });
    // zip の中は node-vXX-win-x64/ の一階層下にある。平らに移す。
    const tmp = join(out, '.runtime-tmp');
    await mkdir(tmp, { recursive: true });
    execFileSync('tar', ['-xf', nodeZip, '-C', tmp], { stdio: 'inherit' });
    const { readdir } = await import('node:fs/promises');
    const [inner] = await readdir(tmp);
    await cp(join(tmp, inner), join(out, 'runtime'), { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    log(`  入れた: runtime（同梱の Node。${inner}）`);
  } else {
    log('  Node は同梱していません（--node-here / --node-exe / --node-zip）');
  }

  // **組んだあとに測る。**深さが伸びたことに気づけるのは、ここだけ。
  // 落ちるのは利用者が展開するときで、そのときこちらは何も動いていない。
  const final = await deepest(out);
  if (final.length > DEPTH_BUDGET) {
    throw new Error(
      `中の道が深すぎます: ${final.length} 文字（許すのは ${DEPTH_BUDGET} まで）\n`
      + `  ${final.rel}\n`
      + 'Windows は道の全体が 260 文字を超えると開けません。'
      + '深いまま配ると、利用者の展開が途中で止まります。',
    );
  }
  log(`  いちばん深いもの: ${final.length} 文字（置き場所は ${(260 - 1) - 1 - final.length} 文字まで）`);

  return {
    out,
    version: stamped,
    bundledNode: Boolean(nodeZip || exe),
    deepest: final.length,
  };
}

// Windows では `file://` + argv[1] にすると一致しない。
// argv[1] は Z:\...\run.mjs（円記号・ドライブ文字）、import.meta.url は
// file:///Z:/.../run.mjs。**一致しないので、中身が丸ごと動かない。**
// 何も言わずに終了コード0で終わるので、気づけない（実機でそうなった）。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(root, arg('--out', 'dist/aas-portable'));
  console.log('持ち運び版を組み立てます');
  const r = await bundle({
    out,
    nodeZip: arg('--node-zip'),
    nodeExe: arg('--node-exe'),
    nodeHere: process.argv.includes('--node-here'),
    nodeName: arg('--node-name'),
    ...(arg('--src') ? { srcRoot: resolve(arg('--src')) } : {}),
    version: arg('--version'),
    log: (l) => console.log(l),
  });
  console.log(`\n  できました: ${r.out}`);
  console.log(`  版: ${r.version} / Node 同梱: ${r.bundledNode ? 'あり' : 'なし'}`);
  console.log(`  いちばん深いもの: ${r.deepest} 文字 / 置き場所に使えるのは ${(260 - 1) - 1 - r.deepest} 文字`);
}
