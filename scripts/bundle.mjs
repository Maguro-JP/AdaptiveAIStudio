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
import { cp, mkdir, writeFile, rm, readFile, stat, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** package.json の版。--version を渡さなかったときの控え。 */
function pkgVersion(srcRoot) {
  try {
    return JSON.parse(readFileSync(join(srcRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
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

  // 入口。押せばいいものが一つだけ表にある形にする。
  await writeFile(join(out, 'AdaptiveAIStudio.cmd'),
    ['@echo off', 'call "%~dp0app\\start.cmd" %*'].join('\r\n') + '\r\n', 'utf8');
  log('  置いた: AdaptiveAIStudio.cmd');

  // 名前は普通のプログラムの作法に合わせる（README / VERSION）。
  // 中身は利用者の言語で書く。**名前は機械と慣習、中身は人。**
  await writeFile(join(out, 'README.txt'),
    [
      'AdaptiveAIStudio',
      '',
      '  AdaptiveAIStudio.cmd をダブルクリックしてください。',
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
      '新しくするときは、入口の「7 新しくする」を選んでください。',
    ].join('\r\n') + '\r\n', 'utf8');
  log('  置いた: README.txt');

  // 版は独立した1ファイルにする。目印の中に混ぜると、読む側が
  // 目印を解釈しないと版が分からない。VERSION なら誰でも読める。
  await writeFile(join(out, 'VERSION'), `${version ?? pkgVersion(srcRoot)}\r\n`, 'utf8');
  log(`  置いた: VERSION（${version ?? '不明'}）`);

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

  const pkg = JSON.parse(await readFile(join(srcRoot, 'package.json'), 'utf8'));
  return { out, version: version ?? pkg.version, bundledNode: Boolean(nodeZip || exe) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
}
