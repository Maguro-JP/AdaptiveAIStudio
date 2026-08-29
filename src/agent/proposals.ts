/**
 * 提案キュー — AIが自分で気づいたことを、実行せずに溜める場所。
 *
 * 目指しているのは「LLMを動かす場所」ではなく「AIが動く場所」。
 * そのためには、依頼を待つだけでなく、自分で調べて考えて提案する必要がある。
 *
 * ただし勝手に手を出させはしない。**提案は提案のまま置く。**
 * 実行するかは利用者が決める。自発性と暴走は紙一重なので、
 * 「気づくこと」と「やること」の間に必ず承認を挟む。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ProposalKind =
  | 'bug'          // 壊れている可能性
  | 'risk'         // 将来困りそうなところ
  | 'test'         // 検査が足りていない
  | 'cleanup'      // 整理できる
  | 'question';    // 判断を仰ぎたい

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'done';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  /** なぜそう考えたか。根拠のない提案は雑音になる。 */
  rationale: string;
  /** 根拠となったファイルや出力 */
  evidence: string[];
  /** 実行するとしたら何をするか。依頼文としてそのまま使える形にする。 */
  suggestedAction: string;
  status: ProposalStatus;
  createdAt: string;
  /** 同じ提案を何度も出さないための指紋 */
  fingerprint: string;
}

export class ProposalQueue {
  readonly #path?: string;
  #items: Proposal[] = [];
  /**
   * 調べ終えた手がかりの指紋。
   * 提案にならなかった（＝問題なしだった）ものも覚えておく。
   * これが無いと、同じところを何度も調べ直して計算を捨てることになる。
   */
  #examined = new Set<string>();

  constructor(path?: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8')) as
        Proposal[] | { items: Proposal[]; examined: string[] };
      if (Array.isArray(raw)) {
        this.#items = raw;
      } else {
        this.#items = raw.items ?? [];
        this.#examined = new Set(raw.examined ?? []);
      }
    } catch {
      this.#items = [];
      this.#examined = new Set();
    }
  }

  markExamined(fingerprint: string): void {
    this.#examined.add(fingerprint);
  }

  /** 提案済み・調査済みの両方。次に何を調べるかの判断に使う。 */
  seen(): Set<string> {
    return new Set([...this.#examined, ...this.#items.map((p) => p.fingerprint)]);
  }

  all(): Proposal[] {
    return [...this.#items];
  }

  open(): Proposal[] {
    return this.#items.filter((p) => p.status === 'open');
  }

  find(id: string): Proposal | undefined {
    // 前方一致でも引けるようにする。毎回全部打たせない。
    return this.#items.find((p) => p.id === id)
      ?? this.#items.find((p) => p.id.startsWith(id));
  }

  /**
   * 追加する。重複は入れない。
   *
   * 手がかりの指紋だけで見ると取りこぼす。
   * 別々の手がかりから調べても、行き着く先が同じ発見になることがあるため、
   * 提案の中身でも重複を判定する。
   */
  add(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal | undefined {
    const contentKey = normalizeTitle(p.title);
    const duplicate = this.#items.find(
      (x) => x.status !== 'rejected' &&
        (x.fingerprint === p.fingerprint || normalizeTitle(x.title) === contentKey),
    );
    if (duplicate) return undefined;

    const item: Proposal = {
      ...p,
      id: `p${(this.#items.length + 1).toString().padStart(3, '0')}`,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.#items.push(item);
    return item;
  }

  setStatus(id: string, status: ProposalStatus): Proposal | undefined {
    const item = this.find(id);
    if (item) item.status = status;
    return item;
  }

  async save(): Promise<void> {
    if (!this.#path) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, JSON.stringify({
        items: this.#items,
        examined: [...this.#examined],
      }, null, 2), 'utf8');
    } catch {
      // 保存できなくても本体は止めない
    }
  }
}

/** 表記ゆれを吸収して、同じ発見を同じと見なす。 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s、。,.:：「」"'`]/g, '');
}

const KIND_LABEL: Record<ProposalKind, string> = {
  bug: '不具合の疑い',
  risk: 'リスク',
  test: '検査不足',
  cleanup: '整理',
  question: '要判断',
};

export function formatProposal(p: Proposal, verbose = false): string {
  const head = `${p.id} [${KIND_LABEL[p.kind]}] ${p.title}`;
  if (!verbose) return head;
  const lines = [head, `  理由: ${p.rationale}`];
  if (p.evidence.length > 0) lines.push(`  根拠: ${p.evidence.join(', ')}`);
  lines.push(`  やること: ${p.suggestedAction}`);
  return lines.join('\n');
}
