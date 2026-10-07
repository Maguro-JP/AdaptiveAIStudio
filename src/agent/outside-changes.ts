/**
 * 外のツール（MCP）と `run_command` が変えたファイルの、**前の中身**を記録する。
 *
 * この場所の書くツール（`write_file` / `edit_file`）は、書く直前に前の中身を渡して
 * くれるので、巻き戻し（Checkpoint）も戻す（UndoStore）も効く。外のツールは
 * 何をどこに書くか前もって分からないので、どちらにも入っていなかった。
 * 打ち切って巻き戻すと、この場所で書いた分だけ戻り、外のツールの分は残る。
 * **半分だけ戻った作業場は、戻していないより悪い。**
 *
 * 前の中身は、三つの道で取る。
 *
 *   ・呼ぶ前から変わっていた（git status に載っていた）ファイルは、呼ぶ前に読んでおく。
 *     git に無い姿なので、後からは取れない
 *   ・呼ぶ前はきれいだった（載っていなかった）ファイルは、HEAD から取る。
 *     きれい＝作業ツリーと索引と HEAD が同じ、なので HEAD が「前」そのもの
 *   ・呼ぶ前に無かったファイル（新しく作られた）は、「前は無い」（戻すと消す）
 *
 * 呼ぶたびに `before()` → ツール → `after()`。同じ道は最初の一度だけ記録する
 * （Checkpoint / UndoStore と同じ）。大きすぎるもの・取れないものは読まず、名前だけ返す
 * （`unrecorded`）。**取れないものを「前は無い」と読まない。**読むと、戻すときに在った
 * ファイルを消す。HEAD がリンク・submodule も同じく名前だけ。二進（utf8 で往復しないもの）は
 * バイト列のまま持つ（文字列にすると、戻すときに別の中身を書く）。
 *
 * **見えないところ。**git の管理下でない作業場では何も分からない（`comparable: false`）。
 * `.gitignore` の中は git が挙げないので見えない。`run_command` が `git commit` で HEAD を
 * 動かした回は、その後に「前」として引く HEAD が変わっている。
 */
import { lstat, readFile } from 'node:fs/promises';
import { workspaceStamp, stampChanges, headContent, type WorkspaceStamp } from './workspace-stamp.ts';
import { contentOf, contentBytes, isAbsent, type FileContent } from '../harness/put-back.ts';
import { safeResolve } from './tools/paths.ts';
import type { Tool } from './tools/types.ts';

/** 一つの道につき、これより大きいものは記録しない（UndoStore と同じ 8MiB）。 */
export const OUTSIDE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 一回（1ターン）で記録する合計の上限。
 *
 * `.gitignore` の無い作業場で `run_command` が `node_modules` を作った次の呼び出しは、
 * その全部が「呼ぶ前から変わっていた」側に来る。上限が無いと、ツールを呼ぶたびに
 * 数千件を読んで持ち続ける。超えた分は名前だけ（戻せない）。
 */
export const OUTSIDE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface OutsideChange {
  /** 作業場からの道。 */
  path: string;
  /** 前の中身。無かったなら `undefined`（戻すときは消す）。utf8 で往復しないものはバイト列。 */
  previous: FileContent | undefined;
}

export interface OutsideResult {
  /** 変わった道と前の中身。 */
  changes: OutsideChange[];
  /** 変わったが、前の中身を記録できなかった道（大きすぎる・取れない）。戻せない。 */
  unrecorded: string[];
  /** 比べられたか。git の管理下でなければ false（changes は空）。 */
  comparable: boolean;
}

export class OutsideChanges {
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #maxTotalBytes: number;
  #bytes = 0;
  #before: WorkspaceStamp | undefined;
  /** 呼ぶ前から変わっていた道の、呼ぶ前の中身。 */
  readonly #kept = new Map<string, FileContent | undefined>();
  /** 前の中身を記録できなかった道。 */
  readonly #unrecorded = new Set<string>();
  /** もう返した道。二度目は返さない（最初の一度が「前」）。 */
  readonly #reported = new Set<string>();

  constructor(root: string, opts: { maxBytes?: number; maxTotalBytes?: number } = {}) {
    this.#root = root;
    this.#maxBytes = opts.maxBytes ?? OUTSIDE_MAX_BYTES;
    this.#maxTotalBytes = opts.maxTotalBytes ?? OUTSIDE_MAX_TOTAL_BYTES;
  }

  /** ツールを呼ぶ手前。作業場の記録を取り、既に変わっているファイルの中身を記録する。 */
  async before(): Promise<void> {
    this.#before = await workspaceStamp(this.#root);
    if (!this.#before) return;
    for (const [path, mark] of this.#before) {
      // もう返した道は「前」が決まっている。二度読まない。
      if (this.#reported.has(path) || this.#kept.has(path) || this.#unrecorded.has(path)) continue;
      const abs = safeResolve(this.#root, path);
      if (!abs) continue;
      let s: import('node:fs').Stats | undefined;
      try {
        // リンクを辿らない（作業場の記録も lstat で見ている）。辿ると、フォルダを指すリンクを「前は無い」と読んで戻すときに消し、
        // ファイルを指すリンクは中身を記録して、戻すとリンクが普通のファイルの写しに変わっていた
        s = await lstat(abs);
      } catch (e) {
        // 「無い」だけが「前は無い」。ほかの読めなさ（権限・掴まれている）は記録できなかった道にする（戻すときに消さない）
        if (!isAbsent(e)) { this.#unrecorded.add(path); continue; }
      }
      // リンクは中身では戻せない。記録できなかった道にする（「前は無い」と読まない）
      if (s?.isSymbolicLink()) { this.#unrecorded.add(path); continue; }
      if (!s || !s.isFile()) {
        // 消されている（` D`）か、ファイルでない。前は「無い」。
        if (!s || mark.endsWith(' -')) this.#kept.set(path, undefined);
        continue;
      }
      if (s.size > this.#maxBytes || this.#bytes + s.size > this.#maxTotalBytes) {
        this.#unrecorded.add(path);
        continue;
      }
      // バイト列で読む。二進や Shift_JIS を utf8 で読むと、戻すときに壊す。
      const bytes = await readFile(abs).catch(() => undefined);
      if (bytes === undefined) { this.#unrecorded.add(path); continue; }
      this.#bytes += bytes.length;
      this.#kept.set(path, contentOf(bytes));
    }
  }

  /** ツールを呼んだ後。変わった道と、その前の中身を返す。 */
  async after(): Promise<OutsideResult> {
    const before = this.#before;
    this.#before = undefined;
    if (!before) return { changes: [], unrecorded: [], comparable: false };
    const now = await workspaceStamp(this.#root);
    if (!now) return { changes: [], unrecorded: [], comparable: false };

    const changes: OutsideChange[] = [];
    const unrecorded: string[] = [];
    for (const path of stampChanges(before, now)) {
      if (this.#reported.has(path)) continue;
      this.#reported.add(path);
      if (this.#unrecorded.has(path)) { unrecorded.push(path); continue; }
      if (this.#kept.has(path)) { changes.push({ path, previous: this.#kept.get(path) }); continue; }
      /*
       * 呼ぶ前はきれいだった（記録に無い）。**`??` でも HEAD を引く。**
       * `git rm --cached`（作業ツリーには残して追跡をやめる）や、`git mv` の後に元の名前へ書く回は、
       * 在ったファイルが `??` で出てくる。`??` を「前は無い」と読むと、戻すときにそれを消す。
       * HEAD に無いときだけ「前は無い」。
       */
      const head = await headContent(this.#root, path, Math.min(this.#maxBytes, this.#maxTotalBytes - this.#bytes));
      if (head.kind === 'absent') { changes.push({ path, previous: undefined }); continue; }
      if (head.kind === 'unavailable') { this.#unrecorded.add(path); unrecorded.push(path); continue; }
      this.#bytes += contentBytes(head.content);
      changes.push({ path, previous: head.content });
    }
    return { changes, unrecorded, comparable: true };
  }

  /** この回に、外のツールが変えたと分かった道（名前順）。 */
  get paths(): string[] {
    return [...this.#reported].sort();
  }
}

/**
 * 外のツール（`run_command`・MCP）が走っている間に変わった道を集める。
 *
 * 段取りと Team は、依頼の始めと終わりの前後比べで「外で変わったもの」を「戻す」に載せる。それだけだと、その間に利用者が
 * 別の画面で保存したファイルも依頼が変えたものとして載り、戻すと利用者の書いた分が消えた。外のツールを呼ぶたびに前後を比べて、
 * そのツールが走っている間に変わった道を覚える。依頼の終わりの前後比べで変わっていても、書くツールが書いたのでも、
 * ここに無いのでもない道は、依頼が変えたとは言えない（よそで変わった）。
 *
 * 外のツールが走っている間に利用者が保存した分は見分けられない（依頼が変えたものとして載る）。比べられない（git の管理下でない・
 * git が動かない）ときは、前と同じく全部を依頼の分とみなす（`blind`）。
 */
export class ToolWindows {
  readonly #root: string;
  readonly #touched = new Set<string>();
  #blind = false;

  constructor(root: string) {
    this.#root = root;
  }

  /** 呼ぶ前と後に作業場の記録を取って、その間に変わった道を覚える包み。 */
  wrap(tool: Tool): Tool {
    return {
      ...tool,
      run: async (args, ctx) => {
        const before = await workspaceStamp(this.#root).catch(() => undefined);
        try {
          return await tool.run(args, ctx);
        } finally {
          const after = await workspaceStamp(this.#root).catch(() => undefined);
          if (!before || !after) this.#blind = true;
          else for (const p of stampChanges(before, after)) this.#touched.add(p);
        }
      },
    };
  }

  /** 外のツール（`execute` と `mcp`）だけを包んだツールの一式。 */
  pool<T extends { execute: Tool[]; mcp?: Tool[] }>(pool: T): T {
    return {
      ...pool,
      execute: pool.execute.map((t) => this.wrap(t)),
      ...(pool.mcp ? { mcp: pool.mcp.map((t) => this.wrap(t)) } : {}),
    };
  }

  /** 外のツールが変えたかもしれない道か。比べられなかった回は、どれもそうとみなす。 */
  mayHaveTouched(path: string): boolean {
    return this.#blind || this.#touched.has(path);
  }
}
