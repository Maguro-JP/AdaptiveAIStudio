/**
 * 一つの会話が持つもの。
 *
 * 画面で二つの会話を同時に動かすため、`Session` から会話ごとの状態をここへ分けた（DECISIONS 09-26）。
 * 共有の作業場（モデルの口・記憶・harness・外のツール・「戻す」の記録）は `Session` に残る。
 *
 * ここに置くのは、会話を切り替えたら入れ替わるものだけ。二つの会話が同じものを書き換えると、
 * 履歴や差分が混ざる。
 */
import type { ProviderMessage, ToolCall } from '../providers/contract.ts';
import type { RequestScope } from '../agent/tools/types.ts';
import { Forum } from '../harness/deliberation.ts';

export interface LastTurn {
  instruction: string;
  tools: string[];
  changed: string[];
  checked: string;
}

export class Conversation {
  /** いままでのやりとり。 */
  readonly history: ProviderMessage[] = [];
  /** 走っている依頼。無ければ undefined。 */
  running?: AbortController;
  /** いまの依頼文。 */
  instruction = '';
  /** いま添えている覚え。結果が出たら、ここへ書き戻す。 */
  recalledIds: string[] = [];
  /**
   * 直前の回で何をしたか。
   *
   * 嫌がられたときに「このとき何をしていたか」を添えるために持つ。
   * これが無いと、覚えが符丁の羅列になって、次の手が変わらない。
   */
  lastTurn?: LastTurn;
  /** 書き込みの直前に作られた差分。承認の問い合わせを通り道にして拾う。 */
  readonly diffs = new Map<string, { diff: string; created: boolean }>();

  /** この会話の協議の場。依頼ごとに開き直す。 */
  readonly forum = new Forum();
  /** この依頼で呼んだツール（規則が積み重ねを見る）。依頼ごとに空にする。 */
  readonly toolHistory: ToolCall[] = [];

  /**
   * 作業場の既定の会話か（`Session` が立てる）。既定の会話は、共有の harness の依頼（札 ''）で数える。
   * ほかの会話は、依頼ごとの札（`requestKey`）で数える。
   */
  isDefault = false;

  /** ツールまで届ける、この会話の依頼の入れ物。 */
  readonly request: RequestScope = {
    instruction: () => this.instruction,
    history: this.toolHistory,
    forum: this.forum,
    metricsKey: () => (this.isDefault ? '' : this.requestKey),
  };

  /** 会話を見分ける札。承認の「この依頼のあいだは訊かない」を、会話と依頼の組で覚えるのに使う。 */
  readonly key = `c${Math.random().toString(36).slice(2, 10)}`;
  /** この会話で何件目の依頼か。 */
  requestSeq = 0;

  /** いまの依頼を見分ける札（会話と依頼の番号の組）。別の会話の依頼と取り違えない。 */
  get requestKey(): string { return `${this.key}:${this.requestSeq}`; }

  /** 依頼の番号を進める（段取りのように、依頼文や協議を切らずに番号だけ進めたいとき）。 */
  nextRequest(): void { this.requestSeq += 1; }

  /** 依頼を始める。依頼文を置き、規則の積み重ねと協議を切る（前の依頼の分で判じない）。 */
  beginRequest(instruction: string): void {
    this.nextRequest();
    this.instruction = instruction;
    this.toolHistory.length = 0;
    this.forum.clear();
  }

  get busy(): boolean { return this.running !== undefined; }

  /**
   * 続きから話す。残してあったやりとりを積み直す。
   *
   * **積む前に空にする。**足すだけにすると、会話を切り替えたときに
   * 前の会話が下に残り、別の話が地続きに見える。
   */
  restore(messages: readonly ProviderMessage[]): void {
    this.history.length = 0;
    this.history.push(...messages);
  }

  /** 話の続きを切る。覚えたことは消えない。忘れるのは、いま話していた流れだけ。 */
  reset(): void { this.history.length = 0; }
}
