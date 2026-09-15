/**
 * チェックポイント — 失敗したら元に戻せるようにする。
 *
 * 無人で回す以上、途中で行き詰まることはある。
 * そのとき中途半端に壊れた状態を残すと、次の作業がさらに難しくなる。
 * 「やってみて、駄目なら戻す」を安全にするための仕掛け。
 *
 * git があるならそちらが本来の安全網。これは git 管理外や
 * 未コミット状態でも巻き戻せるようにする補助。
 */
import { readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeResolve } from '../agent/tools/paths.ts';

interface Saved {
  path: string;
  /** 元々存在しなかった場合は undefined（巻き戻しでは削除する） */
  content?: string;
}

export class Checkpoint {
  readonly #root: string;
  readonly #saved = new Map<string, Saved>();

  constructor(root: string) {
    this.#root = root;
  }

  get size(): number {
    return this.#saved.size;
  }

  /** 書き込む直前の状態を控える。同じファイルは最初の1回だけ。 */
  async capture(relPath: string): Promise<void> {
    if (this.#saved.has(relPath)) return;
    const abs = safeResolve(this.#root, relPath);
    if (!abs) return;
    const content = await readFile(abs, 'utf8').catch(() => undefined);
    this.#saved.set(relPath, { path: relPath, content });
  }

  /** 控えた状態へ戻す。戻せた件数を返す。 */
  async restore(): Promise<string[]> {
    const restored: string[] = [];
    for (const saved of this.#saved.values()) {
      const abs = safeResolve(this.#root, saved.path);
      if (!abs) continue;
      try {
        if (saved.content === undefined) {
          // 元々無かったファイル。作られていれば消す。
          if (await stat(abs).catch(() => undefined)) {
            await unlink(abs);
            restored.push(saved.path);
          }
        } else {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, saved.content, 'utf8');
          restored.push(saved.path);
        }
      } catch {
        // 1件戻せなくても他は戻す
      }
    }
    this.#saved.clear();
    return restored;
  }

  /** 成功したので控えを捨てる。 */
  commit(): void {
    this.#saved.clear();
  }

  changedPaths(): string[] {
    return [...this.#saved.keys()];
  }
}
