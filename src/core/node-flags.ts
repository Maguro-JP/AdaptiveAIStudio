/**
 * この Node で .ts をそのまま動かすのに、旗が要るか。
 *
 * 型剥がしは 22.6 で旗付きで入り、22.18 / 23.6 / 24 で旗なしになった。
 * 旗が要る版で付け忘れると、.ts を起こした瞬間に文法の誤りで落ちる。
 * 要らない版に付けても害は無い（警告が一つ出るだけ）。
 * scripts/run-tests.mjs にも同じ判断がある。二つに割れているのは、
 * scripts は依存を持たず素の JS で在るため。
 */
export function needsStripFlag(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major >= 24) return false;
  if (major === 23) return minor < 6;
  if (major === 22) return minor < 18;
  return true;
}
