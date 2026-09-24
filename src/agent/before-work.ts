/**
 * 作業前の記録。**軽いものと重いものを、別の合図で取る。**
 *
 * 記録は二つある。
 *
 *   ・テストの数（`snapshotTests`）。ディレクトリを歩いて数えるだけで軽い
 *   ・作業前の成否（ベースライン）。テストを一度走らせるので重い
 *
 * 二つとも `changesFilesHere`（この場所のツール）の手前でだけ取っていた。
 * 外のツール（MCP）が先にテストを消すと、数を記録した時点で既に減っている。
 * 作業後に「減っていない」と読むので、**消したことを見逃す。**
 *
 * 重い方は外のツールの手前に置けない（1ターンが何十秒も伸びる。実測、
 * `docs/DECISIONS.md` 2026-09-23）。軽い方は置ける。だから分ける。
 *
 *   ・数は `mayChangeFiles`（外のツールを含む）の手前で、一度だけ
 *   ・成否は `changesFilesHere`（この場所のツール）の手前で、一度だけ
 *
 * 作業後の確かめ（直させるループ）を回すかどうかは、重い方を取ったか
 * （`measured`）で決める。外のツールだけの回は、軽い方と一緒に作業場の記録
 * （`stamp`）も取っておき、終わったときに作業場が変わっていたら一度だけ確かめる
 * （`src/core/session.ts`）。読むだけの MCP を呼んだ回ではテストを走らせない。
 */
import { mayChangeFiles, changesFilesHere } from './tools/write-kind.ts';
import type { WorkspaceStamp } from './workspace-stamp.ts';

export interface BeforeWorkOptions<S> {
  /** 確かめを切っているなら、何も記録しない。 */
  enabled: boolean;
  /** 軽い記録（テストの数）。失敗しても止めない。 */
  snapshot: () => Promise<S>;
  /** 重い記録（作業前の成否）。 */
  measure: () => Promise<void>;
  /**
   * 作業場の記録（`workspaceStamp`）。軽い記録と一緒に取る。
   * 外のツールだけの回に、作業場が変わったかを後で比べるのに使う。
   */
  stamp?: () => Promise<WorkspaceStamp | undefined>;
}

export class BeforeWork<S> {
  readonly #opts: BeforeWorkOptions<S>;
  #tests: S | undefined;
  #stamp: WorkspaceStamp | undefined;
  #snapped = false;
  #measured = false;

  constructor(opts: BeforeWorkOptions<S>) {
    this.#opts = opts;
  }

  /** ツールを走らせる手前で呼ぶ。要る記録だけを、一度ずつ取る。 */
  async atToolStart(name: string): Promise<void> {
    if (!this.#opts.enabled) return;
    if (!this.#snapped && mayChangeFiles(name)) {
      this.#snapped = true;
      this.#tests = await this.#opts.snapshot().catch(() => undefined);
      this.#stamp = await this.#opts.stamp?.().catch(() => undefined);
    }
    if (!this.#measured && changesFilesHere(name)) {
      this.#measured = true;
      await this.#opts.measure();
    }
  }

  /** 作業前のテストの数。まだ何も変えうるツールを呼んでいなければ無い。 */
  get tests(): S | undefined {
    return this.#tests;
  }

  /** 変えうるツール（外のツールを含む）を一度でも呼ぶ手前まで来たか。 */
  get snapped(): boolean {
    return this.#snapped;
  }

  /** 最初に変えうるツールを呼ぶ手前の、作業場の記録。比べられなければ無い。 */
  get stamp(): WorkspaceStamp | undefined {
    return this.#stamp;
  }

  /** この場所のツールで変えうる手前まで来たか（重い記録を取ったか）。 */
  get measured(): boolean {
    return this.#measured;
  }
}
