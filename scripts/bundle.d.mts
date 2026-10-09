/** bundle.mjs の形。素の JS で書いてあるので、型はここで宣言する。 */
export const PAYLOAD: string[];
export function bundle(opts: {
  out: string;
  nodeZip?: string;
  /** 同梱する node.exe の場所 */
  nodeExe?: string;
  /** いま動かしている Node ごと固める */
  nodeHere?: boolean;
  srcRoot?: string;
  version?: string;
  log?: (line: string) => void;
  /** 出力先の data を残すか（入れてある所へ組み直すとき）。既定は残さない */
  keepData?: boolean;
  /** 改名（試験で、使われていて改名できない場面を作るため） */
  renameImpl?: (from: string, to: string) => Promise<void>;
}): Promise<{
  out: string;
  version: string;
  bundledNode: boolean;
  /** 中でいちばん深いものの、根からの長さ */
  deepest: number;
}>;
/** 中でいちばん深いものの、許す長さ。Windows の 260 文字に効く。 */
export const DEPTH_BUDGET: number;
/** 中でいちばん深いもの（根からの相対）。 */
export function deepest(dir: string, skip?: (rel: string) => boolean): Promise<{ rel: string; length: number }>;
/** 配る先を、分かる範囲で決める。分からなければ undefined（当て推量はしない）。 */
export function guessTarget(how: { nodeHere?: boolean; nodeExe?: string }): Promise<string | undefined>;
/** 押せばいい入口の元のファイル。開発中は launcher.cmd、組んだものの中では一つ上の AdaptiveAIStudio.cmd。 */
export function launcherIn(srcRoot: string): string;
/** --version が無いときの版。git に訊けるなら短い印まで足す。 */
export function guessVersion(srcRoot: string): string;
/** 引数を読む。同じ指定は後のものを採り、知らない引数は投げる。 */
export function parseBundleArgs(argv: string[]): {
  out?: string; nodeZip?: string; nodeExe?: string; nodeHere: boolean; keepData: boolean;
  target?: string; src?: string; version?: string;
};
