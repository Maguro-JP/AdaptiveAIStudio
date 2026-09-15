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

export interface TestSnapshot {
  /** テストファイルとその中のテスト件数 */
  files: Map<string, number>;
  totalCases: number;
  totalFiles: number;
}

export interface IntegrityVerdict {
  ok: boolean;
  /** 利用者とモデルに見せる説明 */
  reason?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);
const TEST_FILE = /(\.|_|^)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)tests?\//i;

/** テスト定義の数え方。言語ごとの代表的な書き方だけを見る。 */
const CASE_PATTERNS = [
  /\b(?:test|it)\s*(?:\.\w+)?\s*\(/g,   // JS/TS: test(...) it(...)
  /^\s*def\s+test_\w+/gm,                // Python
  /\bfunc\s+Test\w+\s*\(/g,              // Go
  /^\s*#\[test\]/gm,                     // Rust
];

/** skip / 無効化の痕跡。数と別に監視する。 */
const SKIP_PATTERNS = [
  /\b(?:test|it|describe)\s*\.\s*skip\s*\(/g,
  /\b(?:xit|xdescribe)\s*\(/g,
  /@(?:pytest\.mark\.)?skip/g,
  /\bt\.Skip\s*\(/g,
];

export async function snapshotTests(root: string): Promise<TestSnapshot> {
  const files = new Map<string, number>();
  let totalCases = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;

      const rel = toDisplayPath(root, abs);
      if (!TEST_FILE.test(rel)) continue;

      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) continue;

      const cases = countCases(text) - countSkips(text);
      files.set(rel, Math.max(0, cases));
      totalCases += Math.max(0, cases);
    }
  };

  await walk(root, 0);
  return { files, totalCases, totalFiles: files.size };
}

function countCases(text: string): number {
  let n = 0;
  for (const p of CASE_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

function countSkips(text: string): number {
  let n = 0;
  for (const p of SKIP_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

/**
 * 作業前後を比べる。テストが減っていれば通過とみなさない。
 * 増える分には問題ない（テストを足すのは良いこと）。
 */
export function compareTests(before: TestSnapshot, after: TestSnapshot): IntegrityVerdict {
  const removedFiles = [...before.files.keys()].filter((f) => !after.files.has(f));
  if (removedFiles.length > 0) {
    return {
      ok: false,
      reason: `テストファイルが削除されています: ${removedFiles.join(', ')}。` +
        'テストを消して通すことは認められません。元に戻してから、実装側を直してください。',
    };
  }

  const shrunk: string[] = [];
  for (const [file, count] of before.files) {
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

  return { ok: true };
}
