/**
 * 見たものを、**ファイルに一つ残す。**
 *
 * `doctor` も `selftest` も、画面に出して「そのまま貼ってください」で
 * 終わっていた。開発は Linux、使うのは Windows なので、こちらで確かめ
 * られないことは必ず残る。そこまでは仕方がない。
 *
 * 仕方がなくないのは、**その先を利用者の手作業にしていた**こと。
 * cmd の画面から文字を拾うのは、Windows ではとても面倒
 * （右クリック→範囲選択→Enter、途中で切れる、色が化ける）。
 * 結果として「貼ってください」は「試す係をやってください」と同じになる。
 *
 * だから、**押したらファイルが一つ出る**形にする。
 * 利用者がすることは、そのファイルを一つ投げるところまで。
 *
 * ## 置く場所
 *
 * 押した場所の隣に置く。**探させない。**そこへ書けないとき
 * （Program Files に入れた形）だけ、記録の保存先へ逃がす。
 * どちらに置いたかは、必ず絶対パスで言う。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 色を落とす。ファイルに ESC が入ると、開いた人には読めない。 */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 名前に使う時刻。**JST で書く。**
 *
 * 受け取った側が「いつのものか」を見るので、機械の側の UTC ではなく
 * 人が読む側に合わせる。ファイル名なので記号は使わない。
 */
export function stamp(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}`
    + `-${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}`;
}

export interface Saved {
  path?: string;
  /** 置けなかったときの理由。**黙って諦めない。** */
  why?: string;
}

/**
 * 書ける方へ置く。前から順に試して、最初に書けたところ。
 *
 * 全部駄目でも投げない。**報告が出せないことを、検査そのものの失敗に
 * しない。**画面には出ているので、そこまでは届いている。
 */
export async function saveReport(
  name: string, body: string, dirs: readonly string[],
): Promise<Saved> {
  const file = `${name}-${stamp()}.txt`;
  let last = '';
  for (const dir of dirs) {
    const at = join(dir, file);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(at, plain(body), 'utf8');
      return { path: at };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  return { why: last || '書ける場所がありませんでした' };
}

/** 出したあとに言うこと。**次の一手まで書く。** */
export function tellWhereItWent(saved: Saved): string[] {
  if (!saved.path) {
    return [
      `この内容をファイルに残せませんでした（${saved.why}）。`,
      'この画面の中身をそのまま送ってください。',
    ];
  }
  return [
    '同じ内容をファイルにも残しました。',
    `  ${saved.path}`,
    '',
    'このファイルを、そのまま送ってください（画面から文字を拾わなくて構いません）。',
  ];
}
