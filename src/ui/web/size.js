/**
 * 大きさを、人が読める形にする。
 *
 * **小さいものを「0.0 GB」と言わない。**モデルの一覧は GB 固定で書いていたので、
 * 100MB に満たないものは全部「0.0 GB」になった。置いた本人にも、それが何なのか
 * （途中で切れた取得なのか、小さい模型なのか）が分からない。
 *
 * 添付の大きさ（パネルの中）も同じ形で出していたので、ここに一つ置いて両方から使う。
 */
export function sizeText(bytes) {
  // 分からないものは何も言わない。0 バイトは「0B」と言う（空のファイルは言う値が在る）。
  if (bytes === undefined || bytes === null || bytes === '') return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}
