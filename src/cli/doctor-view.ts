/**
 * doctor の並べ方。
 *
 * 見出しの長さは環境で変わる（外側の詰まりの題は長い）。
 * 固定幅で揃えると、長い見出しの行だけ説明が右へずれて列が崩れる。
 * 崩れた表は、読むたびに目が列を探し直すことになる。
 *
 * そこで幅は**その場の中身から決める**。
 * それでも収まらない見出しは、説明を次の行へ落として列を守る。
 */
import { displayWidth } from './width.ts';

export type Level = 'ok' | 'warn' | 'bad';

export interface Check {
  name: string;
  level: Level;
  detail: string;
  /** 足りないときに、次に打つ一手 */
  fix?: string;
}

export interface ViewStyle {
  mark: Record<Level, string>;
  /** 印の見た目の幅。色の記号は幅に数えられないので別に受け取る。 */
  markWidth: number;
  dim: (s: string) => string;
  /** 次の一手など、注意を引く色 */
  hint: (s: string) => string;
  /** 問題なしを示す色 */
  good: (s: string) => string;
}

/** 見出し列の下限と上限。上限を超えるものは折り返す。 */
export const NAME_MIN = 16;
export const NAME_MAX = 30;

/** 見出し列の幅を、実際の見出しから決める。 */
export function nameColumn(checks: readonly Check[], min = NAME_MIN, max = NAME_MAX): number {
  const longest = checks.reduce((w, ch) => Math.max(w, displayWidth(ch.name) + 2), 0);
  return Math.min(max, Math.max(min, longest));
}

/** 一枚に出す行を組み立てる。表示だけを持ち、状態を持たない。 */
export function formatChecks(checks: readonly Check[], style: ViewStyle): string[] {
  const width = nameColumn(checks);
  const gutter = ' '.repeat(style.markWidth + 1);
  const detailIndent = gutter + ' '.repeat(width);
  const lines: string[] = [];

  for (const check of checks) {
    const nameWidth = displayWidth(check.name);
    if (nameWidth + 1 > width) {
      // 収まらない見出しは、説明を次の行へ。列を崩すよりは行を増やす。
      lines.push(`${style.mark[check.level]} ${check.name}`);
      if (check.detail) lines.push(`${detailIndent}${style.dim(check.detail)}`);
    } else {
      const pad = ' '.repeat(width - nameWidth);
      lines.push(`${style.mark[check.level]} ${check.name}${pad}${style.dim(check.detail)}`);
    }

    if (check.fix) {
      // 続きの行も、矢印の下に揃える。ぶら下がりが崩れると読みにくい。
      const [head, ...rest] = check.fix.split('\n');
      lines.push(style.hint(`${gutter}→ ${head}`));
      for (const line of rest) lines.push(style.hint(`${gutter}  ${line}`));
    }
  }
  return lines;
}

/**
 * 締めの一行。
 * 「N件かたづければ動きます」は、動かない項目(bad)があるときだけ。
 */
export function summaryLine(checks: readonly Check[], style: ViewStyle): string {
  const bad = checks.filter((x) => x.level === 'bad');
  if (bad.length === 0) {
    return style.good('動かせます。')
      + style.dim('  npm run ui  で画面、 npm run agent  で端末。');
  }
  return style.hint(`${bad.length} 件かたづければ動きます。`)
    + style.dim(' 画面（npm run ui）は、モデルが無くても開けます。');
}
