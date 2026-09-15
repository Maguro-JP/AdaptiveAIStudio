/**
 * 端末での見た目の幅。
 *
 * 日本語は2つ分の幅を取る。文字数で揃えると、日本語の行だけずれる。
 * 列が揃っていないと、読むたびに目が探し直すことになる。
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    w += (code >= 0x1100 && (
      code <= 0x115f
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}

/** 幅で揃える。 */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, width - displayWidth(text)));
}
