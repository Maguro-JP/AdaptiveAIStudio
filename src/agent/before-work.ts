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
 * 作業後の確かめを回すかどうかは、今までどおり重い方を取ったか（`measured`）で
 * 決める。外のツールだけの回に確かめを足すと、読むだけの MCP を呼んだ回でも
 * テストが走る。それは別の判断なので、ここでは変えない。
 */
import { mayChangeFiles, changesFilesHere } from './tools/write-kind.ts';

export interface BeforeWorkOptions<S> {
  /** 確かめを切っているなら、何も記録しない。 */
  enabled: boolean;
  /** 軽い記録（テストの数）。失敗しても止めない。 */
  snapshot: () => Promise<S>;
  /** 重い記録（作業前の成否）。 */
  measure: () => Promise<void>;
}

export class BeforeWork<S> {
  readonly #opts: BeforeWorkOptions<S>;
  #tests: S | undefined;
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

  /** この場所のツールで変えうる手前まで来たか（重い記録を取ったか）。 */
  get measured(): boolean {
    return this.#measured;
  }
}
