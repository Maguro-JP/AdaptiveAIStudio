/**
 * 置き場所を、一箇所で決める。
 *
 * これまで `~/.aas` の下という既定が三箇所に散っていて、
 * 逃がすための環境変数も別々だった（AAS_STATE_DIR / AAS_BIN_DIR / AAS_MODELS_DIR）。
 * 置き場所を変えたい理由は毎回同じ**一つ**なのに、三つ設定させていた。
 *
 * 変えたい理由は次の三つで、どれも「根を移したい」だけ。
 *
 *   1. 利用者名が全角で、llama.cpp がモデルを開けない
 *   2. インストール先を ASCII の決まった場所にしたい
 *   3. 何も入れずに、フォルダごと持ち運びたい
 *
 * だから根を一つにする。個別の環境変数も残す（既に設定した人を壊さない）が、
 * 新しく触るのは AAS_HOME だけでよい。
 */
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** この道具の中身が置かれている場所（配布版では app/）。 */
export function installRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * 製品としての根。利用者が見るフォルダ。
 *
 * 配布版はこういう形にしてある。開発中の作業場も、同じ関数で扱える。
 *
 *   AdaptiveAIStudio\        ← ここが返る
 *     AdaptiveAIStudio.cmd    押せばいい入口
 *     app\                   中身。触らなくてよい ← installRoot()
 *     runtime\node.exe       同梱の Node
 *     data\                  記録・モデル・実行ファイル
 */
export function productRoot(from = installRoot()): string {
  // 目印は製品の根に置く。中身（app）の一つ上にあることもある。
  if (existsSync(join(from, '.portable'))) return from;
  const up = resolve(from, '..');
  if (existsSync(join(up, '.portable'))) return up;
  return from;
}

/**
 * 持ち運び版か。
 *
 * 目印のファイルがあるかどうかで決める。環境変数ではなく**置かれ方**で決めるので、
 * フォルダを渡すだけで持ち運びになる。受け取った側は何も設定しなくてよい。
 */
export function isPortable(from = installRoot()): boolean {
  return existsSync(join(from, '.portable'))
    || existsSync(join(resolve(from, '..'), '.portable'));
}

/**
 * 根。ここから下に、記録も実行ファイルもモデルも置く。
 *
 * 決め方の順番。上から先に効く。
 *   1. AAS_HOME（明示。インストーラはこれを書く）
 *   2. .portable があれば、製品の根の下の data
 *   3. ~/.aas（これまでどおり）
 */
export function aasHome(root = installRoot()): string {
  const explicit = process.env.AAS_HOME?.trim();
  // 相対の道は、いまのフォルダではなくプログラムのフォルダから解く（起動した場所ごとに根が割れないように）
  if (explicit) return resolve(root, explicit);

  if (isPortable(root)) return join(productRoot(root), 'data');

  return join(homedir(), '.aas');
}

/**
 * 作業場（コードを書き換える先）の既定。
 *
 * ここまで、決めずに「いま居る場所」（cwd）を使っていた。作業コピーから
 * 動かすぶんには正しい。**入れた版では致命的になる。**
 *
 * 入れる版の入口は `app\start.cmd` で、そこは `cd /d "%~dp0"` する。
 * つまり作業場が `%ProgramFiles%\AdaptiveAIStudio\app` になる。そこは
 * 管理者権限が無いと書けない。**入れて、最初に何か書かせた瞬間に弾かれる。**
 * 書けたら書けたで、プログラムのフォルダを汚す。どちらも困る。
 *
 * だから、いま居る場所が**プログラムの側**なら、そこは使わない。
 * 根の下の `work` を使う（そこは入れた側が書けるようにしてある）。
 *
 * 設定に `agent.root` が書いてあれば、そちらが勝つ。ここは既定だけ。
 */
export function defaultWorkRoot(cwd = process.cwd(), root = installRoot()): string {
  // **配られた形のときだけ効かせる。**作業コピーまで取り上げると、
  // この道具で自分自身を直す使い方が壊れる（実際に壊して、巡回で捕まえた）。
  if (!isDistributed(root)) return resolve(cwd);
  const here = resolve(cwd);
  const product = resolve(productRoot(root));
  if (!insideDir(here, product)) return here;
  return join(aasHome(root), 'work');
}

/**
 * `here` が `dir` そのものか、その下か。Windows は道の大文字と小文字を区別しないので、揃えて比べる
 * （区別していたので、`c:\program files\…` から起こすとプログラムの外と見なし、そこを作業場にしていた）。
 * 走らせる所に関わらず確かめられるよう、どちらの決まりで比べるかを引数で受ける。
 */
export function insideDir(here: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  // 区切りも引数の決まりで選ぶ。`sep` は走らせている機械の区切りなので、Windows で 'linux' を渡すと
  // `/opt/aas` + `\` で比べてしまい、中を外と言っていた（Windows の CI でだけ落ちた）。
  const s = win ? '\\' : '/';
  const a = win ? here.toLowerCase() : here;
  const b = win ? dir.toLowerCase() : dir;
  return a === b || a.startsWith(b.endsWith(s) ? b : b + s);
}

/**
 * 配られた形か（作業コピーではないか）。
 *
 * bundle は中身を必ず `app\` に入れる（scripts/bundle.mjs）。
 * 作業コピーにその形は無い。**置かれ方で見分ける。**
 * 環境変数で判じさせない（入れた側が決めて渡す、の裏返し）。
 */
export function isDistributed(root = installRoot()): boolean {
  if (isPortable(root)) return true;
  if (basename(resolve(root)) !== 'app') return false;
  // 名前だけで見ない。クローンを `app` という名前のフォルダ（Docker の `/app` など）に置くと配った形と見なし、
  // 更新を setup.exe の案内にすり替え、作業場を `~/.aas/work` へ移していた。bundle が `app\` の隣に必ず置くもので見分ける
  const product = resolve(root, '..');
  return existsSync(join(product, 'AdaptiveAIStudio.cmd')) || existsSync(join(product, 'VERSION'));
}

/** 記録の置き場。 */
export function stateDir(root?: string): string {
  return nonEmptyEnv('AAS_STATE_DIR') ?? aasHome(root);
}

/** llama-server の置き場。 */
export function binDir(root?: string): string {
  return nonEmptyEnv('AAS_BIN_DIR') ?? join(aasHome(root), 'bin');
}

/** 空や空白だけの指定は、無いものとして扱う（空の道は、いまのフォルダになってしまう）。 */
function nonEmptyEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * 半角英数字だけで出来ている道か。
 *
 * llama.cpp は全角の混ざった道からモデルを開けない。
 * 利用者名が全角だと `C:\\Users\\＜名前＞\\...` が全部これに当たる。
 */
export function isAsciiPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(path);
}

/**
 * モデルだけの逃げ道。
 *
 * 根が全角を含むとき、**モデルだけ** ASCII の確実な場所へ逃がす。
 * ProgramData は必ず半角英数字で、管理者権限が無くても書ける。
 *
 * プログラムや記録は逃がさない。全角の道でも読み書きできるし、
 * 置き場所が二つに割れるほうが分かりにくい。困るのはモデルだけ。
 *
 * @param home  いまの根
 * @param env   環境（試験から渡せるようにしてある。走らせる場所で結果を変えないため）
 */
export function asciiModelsDir(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (isAsciiPath(home)) return undefined;
  const programData = env.ProgramData;
  if (!programData || !isAsciiPath(programData)) return undefined;
  return join(programData, 'AdaptiveAIStudio', 'models');
}

/**
 * 自作アプリどうしで共有するモデルの保存先（`C:\LLM\gguf`）。
 *
 * モデルは数 GB あるので、アプリごとに持たず 1 か所で共有する（利用者が決めたこと。
 * `.claude/skills/shared-models`）。`LLM_HOME` があればそこ、Windows では無ければ `C:\LLM`。
 * Windows 以外は `LLM_HOME` が無ければ使わない（これまでの保存先のまま）。
 *
 * テストの中（AAS_TESTING=1）では、既定の `C:\LLM` を見ない。使う人の共有の保存先を
 * テストが読んだり書いたりしないため（`scripts/run-tests.mjs` が立てる）。
 */
export function sharedModelsDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const given = env.LLM_HOME?.trim();
  if (given) return join(given, 'gguf');
  if (platform !== 'win32' || env.AAS_TESTING === '1') return undefined;
  return `${env.SystemDrive?.trim() || 'C:'}\\LLM\\gguf`;
}

/** GGUF の置き場。 */
export function modelsDir(root?: string): string {
  // ほかの保存先と同じく、空白だけの指定は無いものとし、前後の空白は落とす（空白だけの名前のフォルダを保存先にしていた）
  const given = nonEmptyEnv('AAS_MODELS_DIR');
  if (given) return given;
  const home = aasHome(root);
  const own = asciiModelsDir(home) ?? join(home, 'models');
  const shared = sharedModelsDir();
  if (!shared) return own;
  // 前の保存先にだけモデルがある人は、そのまま前の保存先を使う（入れ直した途端に「モデルがありません」にしない）。
  // 共有の保存先に 1 つでも入れば、そちらへ移る。前の保存先のものは消さない・動かさない。
  if (!hasGguf(shared) && hasGguf(own)) return own;
  return shared;
}

/**
 * 共有の保存先へ移ったあと、前の保存先に残っていて一覧に出ないモデル。
 * 消さない・動かさない決まりなので、残っていることを言って、移す先を案内する（doctor）。
 */
export function strandedModels(root?: string): { dir: string; names: string[] } | undefined {
  if (nonEmptyEnv('AAS_MODELS_DIR')) return undefined;
  const shared = sharedModelsDir();
  if (!shared || modelsDir(root) !== shared) return undefined;
  const home = aasHome(root);
  const own = asciiModelsDir(home) ?? join(home, 'models');
  let names: string[] = [];
  try { names = readdirSync(own).filter((n) => n.toLowerCase().endsWith('.gguf')); } catch { return undefined; }
  return names.length > 0 ? { dir: own, names: names.sort() } : undefined;
}

function hasGguf(dir: string): boolean {
  try { return readdirSync(dir).some((n) => n.toLowerCase().endsWith('.gguf')); } catch { return false; }
}
