/** bundle.mjs の形。素の JS で書いてあるので、型はここで宣言する。 */
export const PAYLOAD: string[];
export function bundle(opts: {
  out: string;
  nodeZip?: string;
  srcRoot?: string;
  version?: string;
  log?: (line: string) => void;
}): Promise<{ out: string; version: string; bundledNode: boolean }>;
