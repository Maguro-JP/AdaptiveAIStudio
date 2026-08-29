import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * 作業ディレクトリの外へ出さない。
 * `..` やシンボリックリンク経由の脱出を防ぐ最初の関門。
 */
export function safeResolve(root: string, candidate: string): string | undefined {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel === '') return abs;
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (rel.split(sep).includes('..')) return undefined;
  return abs;
}

export function toDisplayPath(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
