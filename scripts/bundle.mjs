/**
 * 持ち運び版を組み立てる。
 *
 * 何も入れられない機械（会社の PC など）で動かすための一式。
 * フォルダを置くだけで動き、外には何も残さない。
 *
 *   ・記録もモデルも実行ファイルも、このフォルダの中（portable.txt が目印）
 *   ・実行時の依存はゼロなので node_modules は要らない
 *   ・Node 自体も同梱できる（--node-zip で渡す）
 *
 * 使い方:
 *   node scripts/bundle.mjs --out dist/aas-portable [--node-zip node-win-x64.zip]
 *
 * Node の zip をここで落としに行かないのは、**組み立てと取得を分ける**ため。
 * 取得は網の繋がる場所（CI）でやり、ここは置く仕事だけをする。
 * そうすると、この道具自体は網が無くても試せる。
 */
import { cp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 持ち運び版に入れるもの。入れないものではなく、**入れるものを挙げる**。 */
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

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/** 中身を並べる。試験から呼べるように、副作用を out だけに閉じる。 */
export async function bundle({ out, nodeZip, srcRoot = root, log = () => {} }) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const item of PAYLOAD) {
    const from = join(srcRoot, item);
    try {
      await stat(from);
    } catch {
      log(`  ない: ${item}（飛ばします）`);
      continue;
    }
    await cp(from, join(out, item), { recursive: true });
    log(`  入れた: ${item}`);
  }

  // 目印。これがあると、記録もモデルもこのフォルダの中に閉じる。
  await writeFile(join(out, 'portable.txt'),
    [
      'このフォルダは「持ち運び版」です。',
      '',
      '記録・モデル・実行ファイルは、すべて隣の aas-home に入ります。',
      'この機械には何も残りません。フォルダごと消せば、跡形もなくなります。',
      '',
      '始め方: start.cmd をダブルクリック',
    ].join('\n'), 'utf8');
  log('  入れた: portable.txt（持ち運びの目印）');

  if (nodeZip) {
    await mkdir(join(out, 'node'), { recursive: true });
    // zip の中は node-vXX-win-x64/ の一階層下にある。平らに移す。
    const tmp = join(out, '.node-tmp');
    await mkdir(tmp, { recursive: true });
    execFileSync('tar', ['-xf', nodeZip, '-C', tmp], { stdio: 'inherit' });
    const { readdir } = await import('node:fs/promises');
    const [inner] = await readdir(tmp);
    await cp(join(tmp, inner), join(out, 'node'), { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    log(`  入れた: node（同梱。${inner}）`);
  } else {
    log('  Node は同梱していません（--node-zip で渡せます）');
  }

  const pkg = JSON.parse(await readFile(join(srcRoot, 'package.json'), 'utf8'));
  return { out, version: pkg.version, bundledNode: Boolean(nodeZip) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(root, arg('--out', 'dist/aas-portable'));
  console.log('持ち運び版を組み立てます');
  const r = await bundle({ out, nodeZip: arg('--node-zip'), log: (l) => console.log(l) });
  console.log(`\n  できました: ${r.out}`);
  console.log(`  版: ${r.version} / Node 同梱: ${r.bundledNode ? 'あり' : 'なし'}`);
}
