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
 *   3. 何も入れずに、フォルダごと持ち運びたい（会社の機械など）
 *
 * だから根を一つにする。個別の環境変数も残す（既に設定した人を壊さない）が、
 * 新しく触るのは AAS_HOME だけでよい。
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
  const explicit = process.env.AAS_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;

  if (isPortable(root)) return join(productRoot(root), 'data');

  return join(homedir(), '.aas');
}

/** 記録の置き場。 */
export function stateDir(root?: string): string {
  return process.env.AAS_STATE_DIR ?? aasHome(root);
}

/** llama-server の置き場。 */
export function binDir(root?: string): string {
  return process.env.AAS_BIN_DIR ?? join(aasHome(root), 'bin');
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

/** GGUF の置き場。 */
export function modelsDir(root?: string): string {
  if (process.env.AAS_MODELS_DIR) return process.env.AAS_MODELS_DIR;
  const home = aasHome(root);
  return asciiModelsDir(home) ?? join(home, 'models');
}
