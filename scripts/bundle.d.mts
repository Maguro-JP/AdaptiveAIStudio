/** bundle.mjs の形。素の JS で書いてあるので、型はここで宣言する。 */
export const PAYLOAD: string[];
export function bundle(opts: {
  out: string;
  nodeZip?: string;
  /** 同梱する node.exe の場所 */
  nodeExe?: string;
  /** いま動かしている Node ごと固める */
  nodeHere?: boolean;
  /** 同梱する Node をどの名前で置くか（node.exe / node.bin） */
  nodeName?: string;
  srcRoot?: string;
  version?: string;
  log?: (line: string) => void;
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
export function deepest(dir: string): Promise<{ rel: string; length: number }>;
/** --version が無いときの版。git に訊けるなら短い印まで足す。 */
export function guessVersion(srcRoot: string): string;
