/**
 * いまどの版が動いているか。
 *
 * bundle は git の管理下に無い。**版が見えないと、古いものを新しいと
 * 思って確かめてしまう。**それをやると、直したはずの不具合が
 * 直っていないように見え、原因を探す時間がまるごと無駄になる。
 * （実際に一度、古い作業コピーで検査を回して、直った件が
 *   落ちたままに見えたことがある。）
 *
 * だから、どの置かれ方でも版が言えるようにする。
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { productRoot, installRoot, isDistributed } from './home.ts';
import { jstDate } from './clock.ts';

export interface Version {
  /** 版。分からなければ undefined */
  id?: string;
  /** どこから分かったか。人に見せる。 */
  from: 'bundle の記録' | 'git' | '不明';
  /** 組み立てた時刻（bundle のみ） */
  builtAt?: string;
}

/**
 * bundle の VERSION を読む。
 *
 * 版を目印の中に混ぜていたが、それだと**読む側が目印の書式を
 * 解釈しないと版が分からない**。VERSION なら、開けば書いてある。
 */
async function fromMarker(root = installRoot()): Promise<Version | undefined> {
  /*
   * **インストール版は `.portable` を消してある。**bundle は VERSION を製品の根
   * （app の親）に置き、setup.exe はそこから `.portable` だけを消して入れる
   * （残すと data\ が Program Files の隣に出来る）。ところが根の見つけ方が
   * `.portable` 頼みだったので、インストール版では VERSION の在る場所を見に行かず、
   * 「分かりません（git の管理下でもbundle でもありません）」と出ていた（実機）。
   * 配られた形（中身が app\）なら、`.portable` の有無に関わらず一つ上も見る。
   */
  const dirs = [productRoot(root), root];
  if (isDistributed(root)) dirs.push(resolve(root, '..'));
  for (const dir of [...new Set(dirs)]) {
    const id = (await readFile(join(dir, 'VERSION'), 'utf8').catch(() => ''))
      .split('\n')[0]?.trim();
    if (!id) continue;
    // 作業コピーでは、書庫に焼き込む印がそのまま残っている。
    // これを版として見せると、嘘の版を報告することになる。git に訊く。
    if (id.startsWith('$Format:')) continue;
    const built = (await readFile(join(dir, '.portable'), 'utf8').catch(() => ''))
      .match(/built\s+(\S+)/)?.[1];
    return { id, from: 'bundle の記録', ...(built ? { builtAt: built } : {}) };
  }
  return undefined;
}

/** 作業コピーなら git に訊く。 */
async function fromGit(root = installRoot()): Promise<Version | undefined> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    const id = stdout.trim();
    if (!id) return undefined;
    // 汚れていれば、そう言う。「この版で確かめた」と言えなくなるため。
    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: root });
    return { id: dirty.trim().length > 0 ? `${id}（未コミットの変更あり）` : id, from: 'git' };
  } catch {
    return undefined;
  }
}

export async function currentVersion(root = installRoot()): Promise<Version> {
  return (await fromMarker(root)) ?? (await fromGit(root)) ?? { from: '不明' };
}

/** 人に見せる一行。 */
export function describeVersion(v: Version): string {
  if (!v.id) return '分かりません（git の管理下でもbundle でもありません）';
  // 組み立てた日付も JST で見せる。UTC のままだと朝 9 時まで昨日。
  const built = v.builtAt && !Number.isNaN(Date.parse(v.builtAt)) ? jstDate(v.builtAt) : v.builtAt?.slice(0, 10);
  return built ? `${v.id}（${v.from}・${built} 組み立て）` : `${v.id}（${v.from}）`;
}
