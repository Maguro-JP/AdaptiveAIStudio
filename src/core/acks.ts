/**
 * 了解した警告の記憶。
 *
 * 一度伝われば済む警告を、毎回出さない。**了解は作業場ごと。**
 * git の管理下でない作業場（社用 PC の Z: など）で「外のツールが変えたかを
 * 比べられない」は、その作業場を使う人が一度了解すれば足りる。別の作業場では、
 * また言う。
 *
 * 保存先は `stateDir()/acks.json`。画面（`/api/acks`）と CLI（`/ack`）の両方から
 * 同じファイルを触るので、**書く直前に読み直して足す**（後から書いた方が前の分を
 * 消さない）。画面は状態を持たない（`src/ui/state.ts`）ので、ここに置く。
 *
 * 取り消せる。**閉じたら開けない、を作らない。**設定の中に「また出す」がある。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** 了解できる警告。増やすときは、ここと ACK_TEXT の両方に足す。 */
export const ACK_IDS = ['outside-uncomparable'] as const;
export type AckId = (typeof ACK_IDS)[number];

/** 人に見せる名前。設定の一覧に出す。 */
export const ACK_TEXT: Record<AckId, string> = {
  'outside-uncomparable': '外のツールが作業場を変えたかを比べられない（git の管理下でない作業場）',
};

export function isAckId(x: unknown): x is AckId {
  return typeof x === 'string' && (ACK_IDS as readonly string[]).includes(x);
}

export interface Ack {
  id: AckId;
  /** 了解した作業場（resolve 済み）。 */
  root: string;
  /** 了解した時刻（ISO）。 */
  at: string;
}

export class AckStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<Ack[]> {
    const raw = await readFile(this.#file, 'utf8').catch(() => undefined);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { acks?: unknown };
      if (!Array.isArray(parsed.acks)) return [];
      return parsed.acks.filter((a): a is Ack =>
        typeof a === 'object' && a !== null
        && isAckId((a as Ack).id) && typeof (a as Ack).root === 'string' && typeof (a as Ack).at === 'string');
    } catch {
      // 壊れたファイルは「何も了解していない」と読む。黙って消さない（書くときに上書きされる）。
      return [];
    }
  }

  async has(id: AckId, root: string): Promise<boolean> {
    const key = resolve(root);
    return (await this.list()).some((a) => a.id === id && a.root === key);
  }

  async add(id: AckId, root: string, now = new Date()): Promise<void> {
    const key = resolve(root);
    const acks = (await this.list()).filter((a) => !(a.id === id && a.root === key));
    acks.push({ id, root: key, at: now.toISOString() });
    await this.#save(acks);
  }

  async remove(id: AckId, root: string): Promise<void> {
    const key = resolve(root);
    await this.#save((await this.list()).filter((a) => !(a.id === id && a.root === key)));
  }

  async #save(acks: Ack[]): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(this.#file, `${JSON.stringify({ acks }, null, 2)}\n`, 'utf8');
  }
}
