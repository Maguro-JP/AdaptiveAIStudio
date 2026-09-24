/**
 * 外のツール（MCP）と `run_command` が変えたファイルの、**前の中身**を記録する。
 *
 * この場所の書くツール（`write_file` / `edit_file`）は、書く直前に前の中身を渡して
 * くれるので、巻き戻し（Checkpoint）も戻す（UndoStore）も効く。外のツールは
 * 何をどこに書くか前もって分からないので、どちらにも入っていなかった。
 * 打ち切って巻き戻すと、この場所で書いた分だけ戻り、外のツールの分は残る。
 * **半分だけ戻った作業場は、戻していないより悪い。**
 *
 * 前の中身は、二つの道で取る。
 *
 *   ・呼ぶ前から変わっていた（git status に載っていた）ファイルは、呼ぶ前に読んでおく。
 *     git に無い姿なので、後からは取れない
 *   ・呼ぶ前はきれいだった（載っていなかった）ファイルは、索引（index）から取る。
 *     きれい＝作業ツリーと索引が同じ、なので索引が「前」そのもの
 *   ・呼ぶ前に無かったファイル（新しく作られた）は、「前は無い」（戻すと消す）
 *
 * 呼ぶたびに `before()` → ツール → `after()`。同じ道は最初の一度だけ記録する
 * （Checkpoint / UndoStore と同じ）。大きすぎるものは読まず、名前だけ返す。
 *
 * **見えないところ。**git の管理下でない作業場では何も分からない（`comparable: false`）。
 * `.gitignore` の中は git が挙げないので見えない。
 */
import { readFile, stat } from 'node:fs/promises';
import { workspaceStamp, stampChanges, indexContent, type WorkspaceStamp } from './workspace-stamp.ts';
import { safeResolve } from './tools/paths.ts';

/** 一つの道につき、これより大きいものは記録しない（UndoStore と同じ 8MiB）。 */
export const OUTSIDE_MAX_BYTES = 8 * 1024 * 1024;

export interface OutsideChange {
  /** 作業場からの道。 */
  path: string;
  /** 前の中身。無かったなら `undefined`（戻すときは消す）。 */
  previous: string | undefined;
}

export interface OutsideResult {
  /** 変わった道と前の中身。 */
  changes: OutsideChange[];
  /** 変わったが、大きすぎて前の中身を記録できなかった道。 */
  tooLarge: string[];
  /** 比べられたか。git の管理下でなければ false（changes は空）。 */
  comparable: boolean;
}

export class OutsideChanges {
  readonly #root: string;
  readonly #maxBytes: number;
  #before: WorkspaceStamp | undefined;
  /** 呼ぶ前から変わっていた道の、呼ぶ前の中身。 */
  readonly #kept = new Map<string, string | undefined>();
  readonly #tooLarge = new Set<string>();
  /** もう返した道。二度目は返さない（最初の一度が「前」）。 */
  readonly #reported = new Set<string>();

  constructor(root: string, opts: { maxBytes?: number } = {}) {
    this.#root = root;
    this.#maxBytes = opts.maxBytes ?? OUTSIDE_MAX_BYTES;
  }

  /** ツールを呼ぶ手前。作業場の記録を取り、既に変わっているファイルの中身を記録する。 */
  async before(): Promise<void> {
    this.#before = await workspaceStamp(this.#root);
    if (!this.#before) return;
    for (const [path, mark] of this.#before) {
      if (this.#kept.has(path) || this.#tooLarge.has(path)) continue;
      const abs = safeResolve(this.#root, path);
      if (!abs) continue;
      const s = await stat(abs).catch(() => undefined);
      if (!s || !s.isFile()) {
        // 消されている（` D`）か、ファイルでない。前は「無い」。
        if (!s) this.#kept.set(path, undefined);
        continue;
      }
      if (s.size > this.#maxBytes) { this.#tooLarge.add(path); continue; }
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text !== undefined) this.#kept.set(path, text);
    }
  }

  /** ツールを呼んだ後。変わった道と、その前の中身を返す。 */
  async after(): Promise<OutsideResult> {
    const before = this.#before;
    this.#before = undefined;
    if (!before) return { changes: [], tooLarge: [], comparable: false };
    const now = await workspaceStamp(this.#root);
    if (!now) return { changes: [], tooLarge: [], comparable: false };

    const changes: OutsideChange[] = [];
    const tooLarge: string[] = [];
    for (const path of stampChanges(before, now)) {
      if (this.#reported.has(path)) continue;
      this.#reported.add(path);
      if (this.#tooLarge.has(path)) { tooLarge.push(path); continue; }
      if (this.#kept.has(path)) { changes.push({ path, previous: this.#kept.get(path) }); continue; }
      // 呼ぶ前はきれいだった（記録に無い）。新しく出てきた untracked なら、前は無い。
      if (now.get(path)?.startsWith('??')) { changes.push({ path, previous: undefined }); continue; }
      // 追跡されていて、変わった・消えた。索引に前の中身がある。
      changes.push({ path, previous: await indexContent(this.#root, path) });
    }
    return { changes, tooLarge, comparable: true };
  }

  /** この回に、外のツールが変えたと分かった道（名前順）。 */
  get paths(): string[] {
    return [...this.#reported].sort();
  }
}
