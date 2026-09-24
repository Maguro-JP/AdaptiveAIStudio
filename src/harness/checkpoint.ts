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
import { safeResolve, toDisplayPath } from '../agent/tools/paths.ts';

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

  /**
   * 書き込む直前の状態を記録する。同じファイルは最初の1回だけ。
   *
   * 鍵は綴りをそろえてから使う。`a.ts` と `./a.ts` を別のファイルとして二つ記録すると、
   * 二つ目は一つ目が書いた後の中身になり、戻すと元に戻らない。
   */
  async capture(relPath: string): Promise<void> {
    const abs = safeResolve(this.#root, relPath);
    if (!abs) return;
    const key = toDisplayPath(this.#root, abs);
    if (this.#saved.has(key)) return;
    const content = await readFile(abs, 'utf8').catch(() => undefined);
    this.#saved.set(key, { path: key, content });
  }

  /**
   * 前の中身を**渡されて**記録する。同じファイルは最初の1回だけ。
   *
   * 外のツール（MCP）や `run_command` が変えたファイルは、変えた後にしか道が分からない。
   * その時点でディスクを読んでも後の中身しか無いので、前の中身は呼ぶ側が
   * （呼ぶ前に読んだもの、または git の索引から）持ってきて渡す。
   * `content` が `undefined` なら「前は無かった」（戻すときは消す）。
   */
  remember(relPath: string, content: string | undefined): void {
    const abs = safeResolve(this.#root, relPath);
    if (!abs) return;
    const key = toDisplayPath(this.#root, abs);
    if (this.#saved.has(key)) return;
    this.#saved.set(key, { path: key, content });
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
