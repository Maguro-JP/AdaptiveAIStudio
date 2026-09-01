/**
 * いまどの版が動いているか。
 *
 * 配布物は git の管理下に無い。**版が見えないと、古いものを新しいと
 * 思って確かめてしまう。**それをやると、直したはずの不具合が
 * 直っていないように見え、原因を探す時間がまるごと無駄になる。
 * （実際に一度、古い作業コピーで検査を回して、直った件が
 *   落ちたままに見えたことがある。）
 *
 * だから、どの置かれ方でも版が言えるようにする。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productRoot, installRoot } from './home.ts';

export interface Version {
  /** 版。分からなければ undefined */
  id?: string;
  /** どこから分かったか。人に見せる。 */
  from: '配布物の記録' | 'git' | '不明';
  /** 組み立てた時刻（配布物のみ） */
  builtAt?: string;
}

/** 配布物の目印に書いてある版を読む。 */
async function fromMarker(): Promise<Version | undefined> {
  for (const dir of [productRoot(), installRoot()]) {
    const raw = await readFile(join(dir, 'portable.txt'), 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    const id = /^version:\s*(.+)$/m.exec(raw)?.[1]?.trim();
    const builtAt = /^built:\s*(.+)$/m.exec(raw)?.[1]?.trim();
    if (id && id !== '(不明)') return { id, from: '配布物の記録', ...(builtAt ? { builtAt } : {}) };
  }
  return undefined;
}

/** 作業コピーなら git に訊く。 */
async function fromGit(): Promise<Version | undefined> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: installRoot() });
    const id = stdout.trim();
    if (!id) return undefined;
    // 汚れていれば、そう言う。「この版で確かめた」と言えなくなるため。
    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: installRoot() });
    return { id: dirty.trim().length > 0 ? `${id}（未コミットの変更あり）` : id, from: 'git' };
  } catch {
    return undefined;
  }
}

export async function currentVersion(): Promise<Version> {
  return (await fromMarker()) ?? (await fromGit()) ?? { from: '不明' };
}

/** 人に見せる一行。 */
export function describeVersion(v: Version): string {
  if (!v.id) return '分かりません（git の管理下でも配布物でもありません）';
  return v.builtAt ? `${v.id}（${v.from}・${v.builtAt.slice(0, 10)} 組み立て）` : `${v.id}（${v.from}）`;
}
