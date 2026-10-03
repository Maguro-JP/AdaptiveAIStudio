/**
 * テストの改ざん検出。
 *
 * 「テストを通す」を目標に無人で回すと、
 * モデルは最短経路として**テストを消す・skipする**方を選ぶことがある。
 * それは通ったのではなく、確認をやめただけ。
 *
 * そこで作業の前後でテストの規模を比べ、減っていたら通過とみなさない。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toDisplayPath } from './tools/paths.ts';
import { isAbsent } from '../harness/put-back.ts';
import { isTestFile, countCases, countSkips } from './test-patterns.ts';

export interface TestSnapshot {
  /** テストファイルとその中のテスト件数 */
  files: Map<string, number>;
  totalCases: number;
  totalFiles: number;
  /**
   * 在るのに読めなかったテストファイルと、中を見られなかったフォルダ（末尾 `/`）。**省略可**（古い記録・作り物）。
   * 読めなかったものを「無い」と数えると、作業の後で一瞬読めなかっただけのテストを「消された」と読み、作業を丸ごと巻き戻していた。
   */
  unreadable?: ReadonlySet<string>;
}

export interface IntegrityVerdict {
  ok: boolean;
  /** 利用者とモデルに見せる説明 */
  reason?: string;
  /**
   * 作業前に在ったテストを、後で読めなかった（`ok` は true のまま）。消えた・減ったとは言えないが、減っていないとも言えない。
   * 呼ぶ側は合格にしない（作業がテストを見られなくして通す形を素通しにしない）。巻き戻す理由にもしない。
   */
  unsure?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);

export async function snapshotTests(root: string): Promise<TestSnapshot> {
  const files = new Map<string, number>();
  const unreadable = new Set<string>();
  let totalCases = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // 無いフォルダは数えない。見られなかったフォルダは、その下を「読めなかった」とする
      if (!isAbsent(e)) unreadable.add(`${toDisplayPath(root, dir)}/`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;

      const rel = toDisplayPath(root, abs);
      if (!isTestFile(rel)) continue;

      let text: string;
      try {
        text = await readFile(abs, 'utf8');
      } catch (e) {
        if (!isAbsent(e)) unreadable.add(rel);
        continue;
      }

      const cases = countCases(text) - countSkips(text);
      files.set(rel, Math.max(0, cases));
      totalCases += Math.max(0, cases);
    }
  };

  await walk(root, 0);
  return { files, totalCases, totalFiles: files.size, ...(unreadable.size > 0 ? { unreadable } : {}) };
}

/**
 * 作業前後を比べる。テストが減っていれば通過とみなさない。
 * 増える分には問題ない（テストを足すのは良いこと）。
 */
export function compareTests(before: TestSnapshot, after: TestSnapshot): IntegrityVerdict {
  // 後で読めなかったものは、消えた・減ったと数えない（分からないだけ。数えると、作業を丸ごと巻き戻す）
  const unknown = (f: string): boolean => {
    const u = after.unreadable;
    if (!u) return false;
    if (u.has(f)) return true;
    for (const d of u) if (d.endsWith('/') && (d === './' || `${f}`.startsWith(d))) return true;
    return false;
  };
  const removedFiles = [...before.files.keys()].filter((f) => !after.files.has(f) && !unknown(f));
  if (removedFiles.length > 0) {
    return {
      ok: false,
      reason: `テストファイルが削除されています: ${removedFiles.join(', ')}。` +
        'テストを消して通すことは認められません。元に戻してから、実装側を直してください。',
    };
  }

  const shrunk: string[] = [];
  for (const [file, count] of before.files) {
    if (!after.files.has(file) && unknown(file)) continue;
    const now = after.files.get(file) ?? 0;
    if (now < count) shrunk.push(`${file} (${count} → ${now})`);
  }
  if (shrunk.length > 0) {
    return {
      ok: false,
      reason: `テストが減っています: ${shrunk.join(', ')}。` +
        'テストの削除・skip で通すことは認められません。実装側を直してください。',
    };
  }

  const unseen = [...before.files.keys()].filter((f) => !after.files.has(f) && unknown(f));
  if (unseen.length > 0) {
    return {
      ok: true,
      unsure: `テストを読めませんでした: ${unseen.join(', ')}。減っていないとは言えないので、通ったとはみなしません。` +
        '読めるようにしてから、もう一度確かめてください。',
    };
  }
  return { ok: true };
}
