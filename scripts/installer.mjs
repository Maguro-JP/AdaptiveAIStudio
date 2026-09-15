/**
 * setup.exe を、**この場で**組む。
 *
 * ここまで、インストーラは CI（Windows）でしか組めないと思っていた。
 * Windows の枠は2倍で数えられるので、タグを付けたときだけに絞っていた。
 * ところが NSIS は Linux でも動く（makensis）。**枠を一度も払わずに組める。**
 *
 * これで、枠を使い切ってもbundle が塞がらない。CI が要るのは、
 * 出来たものを Releases へ置くところだけになる。
 *
 * 使い方:
 *   node scripts/installer.mjs [--out <置き先>] [--version <版>] [--keep]
 *
 * やること（CI と同じ順で、同じものを確かめる）:
 *   1. 作業コピーを別の場所へ写す（**ここが要点**）
 *   2. win-x64 むけのライブラリを入れる
 *   3. Windows の Node を取ってくる
 *   4. bundle.mjs で中身を組む
 *   5. .portable を消す（入れる版には要らない）
 *   6. makensis で setup.exe を組む
 *   7. 取り出して、入っているものを見る
 *
 * **作業コピーの中で組まない。**`npm install --no-save` は、その場の
 * node_modules から「要らないもの」を刈り取る。作業コピーでやって、
 * 検査に要るものまで二度消した。写してから触る。
 */
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync, mkdirSync, statSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 同梱する Node。CI（.github/workflows/release.yml）と揃える。 */
const NODEVER = 'v24.18.0';

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** 在るかどうかだけ見ない。**大きさも見る。**0 バイトでも「在る」は通る。 */
function mustBe(path, atLeast = 1) {
  if (!existsSync(path)) throw new Error(`入っていません: ${path}`);
  const size = statSync(path).size;
  if (size < atLeast) throw new Error(`小さすぎます（${size} バイト）: ${path}`);
  return size;
}

function human(n) {
  return n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
}

// makensis が無ければ、そう言って終わる。黙って別のことをしない。
try {
  // **`-` で渡す。**Linux の makensis は `/VERSION` を「そういう名前の
  // ファイル」として読みに行って落ちる（`/D` は通るので気づきにくい）。
  // Windows の makensis は `-` も `/` も受ける。合わせて `-` にする。
  execFileSync('makensis', ['-VERSION'], { stdio: 'ignore' });
} catch {
  console.error(
    'makensis がありません。\n'
    + '  Debian/Ubuntu: apt-get install -y nsis\n'
    + '  Windows:       choco install nsis\n'
    + 'これが無いと setup.exe は組めません（portable は npm run bundle で組めます）。',
  );
  process.exit(1);
}

const sha = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); }
  catch { return 'nogit'; }
})();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = arg('--version', `${pkg.version}-${sha}`);
const out = resolve(arg('--out', join(root, 'dist', 'AdaptiveAIStudio-Setup.exe')));
const keep = process.argv.includes('--keep');

// 作業場。作業コピーの外に置く（--no-save に刈られないため）。
const work = join(tmpdir(), `aas-installer-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log(`版: ${version}`);
console.log(`作業場: ${work}`);

try {
  console.log('\n== 写す（git の管理下のものだけ）');
  // git archive を使う。dist/ や node_modules を巻き込まない。
  execFileSync('bash', ['-c', `git -C ${JSON.stringify(root)} archive HEAD | tar x -C ${JSON.stringify(work)}`], { stdio: 'inherit' });
  copyFileSync(join(root, 'package-lock.json'), join(work, 'package-lock.json'));

  console.log('\n== 型検査に要るものを入れる');
  run('npm', ['ci', '--no-audit', '--no-fund'], work);

  console.log('\n== モデルを読むライブラリ（win-x64 の CPU・CUDA・Vulkan の分）');
  // **一度に入れる。**二回に分けると、二回目が一回目の分を刈り取る。
  // GPU 用の binary も入れる（release.yml と同じ三つ）。CPU の分だけだと、
  // RTX の機械でも CPU で回る。
  run('npm', [
    'install', '--no-save', '--no-audit', '--no-fund',
    '--omit=optional', '--force', '--ignore-scripts',
    'node-llama-cpp', '@node-llama-cpp/win-x64',
    '@node-llama-cpp/win-x64-cuda', '@node-llama-cpp/win-x64-vulkan',
    // npx は npm に付いてくるが、入れる版には node しか入らない。
    // 入れておかないと「GitHub と繋ぐ」は口があるだけで一度も繋がらない。
    '@modelcontextprotocol/server-github',
  ], work);
  mustBe(join(work, 'node_modules/node-llama-cpp/dist/index.js'));
  mustBe(join(work, 'node_modules/@modelcontextprotocol/server-github/dist/index.js'));
  mustBe(join(work, 'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node'), 1000);
  mustBe(join(work, 'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll'), 1000);
  mustBe(join(work, 'node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll'), 1000);
  // llama/ は llama.cpp の元（34MB）。**JSON だけは import 時に読む。**
  // 丸ごと消して、import できないbundle を出したことがある。
  execFileSync('bash', ['-c',
    `find ${JSON.stringify(join(work, 'node_modules/node-llama-cpp/llama'))} -type f ! -name '*.json' -delete;`
    + `find ${JSON.stringify(join(work, 'node_modules/node-llama-cpp/llama'))} -type d -empty -delete`,
  ]);
  mustBe(join(work, 'node_modules/node-llama-cpp/llama/binariesGithubRelease.json'));
  // 在るだけでなく、**読み込めること**を見る。ここで落ちた版を配った。
  run('node', ['-e', "import('node-llama-cpp').then(() => console.log('  import ok'))"], work);

  console.log('\n== Windows の Node を取ってくる');
  const nodeExe = join(work, 'node.exe');
  run('curl', ['-fL', '--retry', '3', '-o', nodeExe, `https://nodejs.org/dist/${NODEVER}/win-x64/node.exe`]);
  const nodeSize = mustBe(nodeExe, 40_000_000);
  // 本物の Windows 実行ファイルか（MZ で始まる）。
  const head = readFileSync(nodeExe).subarray(0, 2).toString('latin1');
  if (head !== 'MZ') throw new Error(`Windows の実行ファイルではありません: ${head}`);
  console.log(`  node.exe = ${human(nodeSize)}`);

  console.log('\n== 中身を組む');
  const payload = join(work, 'installer', 'payload');
  run('node', [join(work, 'scripts', 'bundle.mjs'),
    '--out', payload, '--node-exe', nodeExe, '--version', version], work);

  // 持ち運びの目印は、入れる版には要らない。
  // **残すと、入れたのに data\\ を自分の隣（Program Files）に作ってしまう。**
  const marker = join(payload, '.portable');
  if (existsSync(marker)) { unlinkSync(marker); console.log('  .portable を消しました（入れる版には要らない）'); }

  console.log('\n== setup.exe を組む');
  run('makensis', [`-DVERSION=${version}`, join(work, 'installer', 'AdaptiveAIStudio.nsi')], work);
  const built = join(work, 'installer', 'AdaptiveAIStudio-Setup.exe');
  const size = mustBe(built, 10_000_000);

  console.log('\n== 開いて、入っているものを見る');
  // **組んだ後を見る。**組む前のフォルダを見ても、入ったかは分からない。
  const x = join(work, 'x');
  try {
    execFileSync('7z', ['x', `-o${x}`, built], { stdio: 'ignore' });
    for (const [what, path, least] of [
      ['同梱の Node', 'runtime/node.exe', 40_000_000],
      ['入口', 'app/start.cmd', 100],
      ['モデルを読む本体', 'app/node_modules/node-llama-cpp/dist/index.js', 100],
      ['モデルを読む binary', 'app/node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node', 1000],
      ['モデルを読む binary（CUDA）', 'app/node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll', 1000],
      ['モデルを読む binary（Vulkan）', 'app/node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll', 1000],
      ['中で読む口', 'app/src/runtime/inproc.ts', 100],
      ['GitHub に繋ぐ道具', 'app/node_modules/@modelcontextprotocol/server-github/dist/index.js', 100],
    ]) {
      console.log(`  ${what}: ${human(mustBe(join(x, path), least))}`);
    }
    if (existsSync(join(x, '.portable'))) throw new Error('.portable が入っています（入れる版には要らない）');
    console.log('  .portable: 無し（正しい）');
  } catch (e) {
    if (/7z/.test(String(e.message)) && !existsSync(x)) {
      console.log('  7z がないので、中は見ていません（apt-get install -y p7zip-full）');
    } else throw e;
  }

  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(built, out);
  console.log(`\nできました: ${out}`);
  console.log(`版: ${version} / 大きさ: ${human(size)}`);
} finally {
  if (keep) console.log(`作業場を残しました: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
