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
import { safeResolve, toDisplayPath } from '../agent/tools/paths.ts';
import { putBack, putBackOrder, contentOf, readPrior, pathKey, foldsCase, type FileContent } from './put-back.ts';

interface Saved {
  path: string;
  /** 元々存在しなかった場合は undefined（巻き戻しでは削除する）。utf8 で往復しないものはバイト列。 */
  content?: FileContent;
}

export class Checkpoint {
  readonly #root: string;
  readonly #saved = new Map<string, Saved>();
  /**
   * 前の中身を読めなかった道（権限・掴まれている）。「前は無かった」と取り違えない。取り違えると、
   * 巻き戻しで元から在ったファイルを消していた。戻せない道として、呼ぶ側に言わせる。
   */
  readonly #unrecorded = new Map<string, string>();

  constructor(root: string) {
    this.#root = root;
  }

  #fold: boolean | undefined;
  /** 道の鍵。作業場が大文字小文字を区別しないかは、作業場ごとに確かめた値を使う（`foldsCase`）。 */
  #key(shown: string): string {
    this.#fold ??= foldsCase(this.#root);
    return pathKey(shown, undefined, this.#fold);
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
    const shown = toDisplayPath(this.#root, abs);
    // 大文字小文字・末尾の点だけ違う綴りも同じファイルとして扱う（Windows・macOS。別に記録すると、二つ目は一つ目が書いた後の中身になる）
    const key = this.#key(shown);
    if (this.#saved.has(key) || this.#unrecorded.has(key)) return;
    // バイト列で読む。二進を utf8 として読むと、戻すときに別の中身を書く。
    let bytes: Buffer | undefined;
    try {
      // 「無い」（途中がファイルで辿れない ENOTDIR も同じ）だけが「前は無かった」
      bytes = await readPrior(abs);
    } catch {
      // ほかの読めなさ（権限・掴まれている）は記録できなかったとして持つ
      this.#unrecorded.set(key, shown);
      return;
    }
    this.#saved.set(key, { path: shown, content: bytes === undefined ? undefined : contentOf(bytes) });
  }

  /**
   * 前の中身を読めず、戻せない道。巻き戻しでは触らない。
   * `changed` を渡すと、その中にある道だけ（書き込めた道だけ）を返す。書けずに終わった道まで「戻せなかった」と言わない。
   */
  unrecorded(changed?: readonly string[]): string[] {
    const keys = changed ? new Set(changed.map((p) => this.keyOf(p)).filter((k): k is string => k !== undefined)) : undefined;
    return [...this.#unrecorded].filter(([k]) => !keys || keys.has(k)).map(([, shown]) => shown).sort();
  }

  /** 記録に使う鍵（綴りをそろえた道）。作業場の外なら undefined。 */
  keyOf(relPath: string): string | undefined {
    const abs = safeResolve(this.#root, relPath);
    return abs ? this.#key(toDisplayPath(this.#root, abs)) : undefined;
  }

  /**
   * 前の中身を**渡されて**記録する。同じファイルは最初の1回だけ。
   *
   * 外のツール（MCP）や `run_command` が変えたファイルは、変えた後にしか道が分からない。
   * その時点でディスクを読んでも後の中身しか無いので、前の中身は呼ぶ側が
   * （呼ぶ前に読んだもの、または git の索引から）持ってきて渡す。
   * `content` が `undefined` なら「前は無かった」（戻すときは消す）。
   */
  remember(relPath: string, content: FileContent | undefined): void {
    const abs = safeResolve(this.#root, relPath);
    if (!abs) return;
    const shown = toDisplayPath(this.#root, abs);
    const key = this.#key(shown);
    if (this.#saved.has(key) || this.#unrecorded.has(key)) return;
    this.#saved.set(key, { path: shown, content });
  }

  /** その道の記録を捨てる（書く手前に記録したが書けなかった道。後で書いたときに、その時点の中身で記録し直すため） */
  forget(relPath: string): void {
    const key = this.keyOf(relPath);
    if (key === undefined) return;
    this.#saved.delete(key);
    this.#unrecorded.delete(key);
  }

  /** 記録した状態へ戻す。戻せた道を返す。 */
  async restore(): Promise<string[]> {
    return (await this.restoreAll()).restored;
  }

  /**
   * 記録した状態へ戻し、**戻せなかった道も返す。**
   *
   * 1件戻せなくても他は戻す。ただし黙って落とさない。戻せなかった道が無いと、
   * 呼ぶ側は「作業場は回の前に戻った」と読んで、次の回の「前」を間違える。
   */
  async restoreAll(only?: readonly string[]): Promise<{ restored: string[]; failed: string[] }> {
    const restored: string[] = [];
    const failed: string[] = [];
    // `only` を渡すと、その中の道だけを当てる（書く手前に記録したが書かなかった道まで書き戻さない）
    const keys = only ? new Set(only.map((p) => this.keyOf(p)).filter((k): k is string => k !== undefined)) : undefined;
    const targets = [...this.#saved].filter(([k]) => !keys || keys.has(k)).map(([, v]) => v);
    for (const saved of putBackOrder(targets)) {
      const r = await putBack(this.#root, saved.path, saved.content);
      if (r === 'restored') restored.push(saved.path);
      else if (r === 'failed') failed.push(saved.path);
    }
    this.#saved.clear();
    this.#unrecorded.clear();
    return { restored, failed };
  }

  /** 成功したので控えを捨てる。 */
  commit(): void {
    this.#saved.clear();
    this.#unrecorded.clear();
  }

  changedPaths(): string[] {
    return [...this.#saved.values()].map((v) => v.path);
  }
}
