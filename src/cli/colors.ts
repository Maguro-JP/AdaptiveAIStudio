/**
 * 端末の色。
 *
 * 同じ定義が CLI ごとに書かれていたので、一箇所にする。
 * 新しく書くものはここから取る。
 */
export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
