/**
 * 溜まったものを片づける。
 *
 * 使っているうちに、要らないものが確実に増える。
 *
 *   ・llama-server の古い版（1つ 150MB〜、cudart を含めると 500MB 超）
 *   ・取得の途中で切れたファイル（.part）
 *   ・古い記録
 *
 * 放っておくと、**気づいたときには数GB**になる。しかも増えているものが
 * 何なのか利用者からは見えない。だから、何をどれだけ消すのかを先に見せ、
 * 消した量を必ず言う。
 *
 * **黙って消さない。**消す物を決めるのはこちらだが、
 * 消したことを隠すと、次に何かが無くなったときに疑う先が増える。
 */
import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { binDir, modelsDir, stateDir } from '../core/home.ts';

export interface Removable {
  path: string;
  bytes: number;
  /** なぜ要らないのか。人に見せる。 */
  why: string;
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path).catch(() => undefined);
  if (!s) return 0;
  if (s.isFile()) return s.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) {
    total += await sizeOf(join(path, name));
  }
  return total;
}

/**
 * 消せるものを挙げる。**消さない。**
 *
 * 挙げるのと消すのを分けておくと、「何が消えるのか」だけを先に見せられる。
 */
export async function findRemovable(opts: {
  keepTag: string;
  maxLogAgeMs?: number;
  now?: number;
} ): Promise<Removable[]> {
  const found: Removable[] = [];
  const now = opts.now ?? Date.now();
  const maxLogAge = opts.maxLogAgeMs ?? 30 * 24 * 60 * 60 * 1000;

  // 古い llama-server。使っている版だけ残す。
  for (const name of await readdir(binDir()).catch(() => [])) {
    if (name === opts.keepTag) continue;
    // b で始まる版の形だけを対象にする。知らない名前は触らない。
    if (!/^b\d+$/.test(name)) continue;
    const path = join(binDir(), name);
    found.push({ path, bytes: await sizeOf(path), why: `古い llama-server（いまは ${opts.keepTag}）` });
  }

  // 途中で切れた取得。次に取り直すので、残しておく意味がない。
  for (const dir of [modelsDir(), binDir()]) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!/\.(part|partial|tmp)$/i.test(name)) continue;
      const path = join(dir, name);
      found.push({ path, bytes: await sizeOf(path), why: '取得の途中で切れたもの' });
    }
  }

  // 古い記録。新しいものは残す（直近の様子は見たいことがある）。
  const logs = join(stateDir(), 'logs');
  for (const name of await readdir(logs).catch(() => [])) {
    const path = join(logs, name);
    const s = await stat(path).catch(() => undefined);
    if (!s || now - s.mtimeMs < maxLogAge) continue;
    const days = Math.floor((now - s.mtimeMs) / 86_400_000);
    found.push({ path, bytes: s.size, why: `${days}日前の記録` });
  }

  return found.sort((a, b) => b.bytes - a.bytes);
}

/** 実際に消す。消せなかったものは、消せなかったと言う。 */
export async function remove(items: Removable[]): Promise<{ freed: number; failed: string[] }> {
  let freed = 0;
  const failed: string[] = [];
  for (const item of items) {
    try {
      await rm(item.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      freed += item.bytes;
    } catch {
      // 使用中で消せないことがある（Windows）。黙らない。
      failed.push(item.path);
    }
  }
  return { freed, failed };
}

export function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}GB`
    : `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 人に見せる形。消す前に必ず出す。 */
export function describe(items: Removable[]): string {
  if (items.length === 0) return '片づけるものはありません。';
  const total = items.reduce((n, i) => n + i.bytes, 0);
  const lines = [`片づけると ${mb(total)} 空きます`, ''];
  for (const i of items.slice(0, 20)) {
    lines.push(`  ${mb(i.bytes).padStart(7)}  ${i.path}`);
    lines.push(`           ${i.why}`);
  }
  if (items.length > 20) lines.push(`  …ほか ${items.length - 20} 件`);
  return lines.join('\n');
}
