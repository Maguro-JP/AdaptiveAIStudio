/**
 * モデルやプログラムのフォルダが同期フォルダ（OneDrive）の中かどうか。
 *
 * OneDrive の「ファイル オンデマンド」は、開くまで実体を持たない。数GBの
 * モデルを初めて読むとき、そこで取りに行く時間がそのまま「読み込みが
 * 終わらない」になる。プログラムの側も、node_modules の小さいファイルを
 * 何千と開くので、立ち上がりが遅くなる。
 *
 * **確かめたのは名前だけ。**その機械で実際に遅いかどうかは、ここでは分からない。
 * だから「遅くなることがあります」と言い、直し方（常に保持）を添えるまでにする。
 */

/** 道の中に OneDrive の名前があるか。区切りは \\ も / も通す。大文字小文字は問わない。 */
export function insideOneDrive(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => /onedrive/i.test(part));
}

export interface PathNote {
  text: string;
  hint: string;
}

/** モデルのフォルダについて言うこと。無ければ undefined。 */
export function modelsDirNote(dir: string): PathNote | undefined {
  if (!insideOneDrive(dir)) return undefined;
  return {
    text: `OneDrive の中にあります: ${dir}`,
    hint: '初回の読み込みが遅くなることがあります（同期の実体を取りに行くため）。\n'
      + 'そのフォルダを右クリック →「このデバイス上に常に保持する」にすると、二度目からは手元から読みます。',
  };
}

/** プログラムのフォルダについて言うこと。無ければ undefined。 */
export function programDirNote(dir: string): PathNote | undefined {
  if (!insideOneDrive(dir)) return undefined;
  return {
    text: `OneDrive の中にあります: ${dir}`,
    hint: '立ち上がりと最初の読み込みが遅くなることがあります（小さいファイルを何千と開くため）。\n'
      + 'そのフォルダを右クリック →「このデバイス上に常に保持する」にしてください。',
  };
}
