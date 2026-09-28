/**
 * 了解した警告の記憶。
 *
 * 一度伝われば済む警告を、毎回出さない。**了解は作業場ごと。**
 * git の管理下でない作業場（社用 PC の Z: など）で「外のツールが変えたかを
 * 比べられない」は、その作業場を使う人が一度了解すれば足りる。別の作業場では、
 * また言う。
 *
 * 保存先は `stateDir()/acks.json`。画面（`/api/acks`）と CLI（`/ack`）の両方から
 * 同じファイルを触るので、**書く直前に読み直して足す**。画面は状態を持たない
 * （`src/ui/state.ts`）ので、ここに置く。鍵は `resolve` した道。Windows の大文字小文字は
 * そろえていない（外れる方向は「また出る」側）。
 *
 * 取り消せる。**閉じたら開けない、を作らない。**設定の中に「また出す」がある。
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readJournal, writeWhole, type JournalOps } from './journal-file.ts';
import { inOrder } from './in-order.ts';

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
  readonly #ops: JournalOps;

  /** `ops` は試験で読む・書くをモックにするためのもの（`journal-file` と同じ）。 */
  constructor(file: string, ops: JournalOps = {}) {
    this.#file = file;
    this.#ops = ops;
  }

  async list(): Promise<Ack[]> {
    // 読むだけではファイルを動かさない（壊れていても脇へ移さない）。移すのは書き換えるときだけ。読むだけで動かすと、
    // 書き換えた直後の正しいファイルを、遅れて届いた読み手が脇へ移すことがある
    const r = await readJournal(this.#file, { ...this.#ops, setAside: async () => false });
    // 無い・読めない・壊れているときは「何も了解していない」と読む（外れる向きは「また出る」側）
    return r.kind === 'value' ? itemsOf(r.value).filter(isAck) : [];
  }

  async has(id: AckId, root: string): Promise<boolean> {
    const key = resolve(root);
    return (await this.list()).some((a) => a.id === id && a.root === key);
  }

  async add(id: AckId, root: string, now = new Date()): Promise<void> {
    const key = resolve(root);
    await this.#rewrite((items) => [
      ...items.filter((a) => !(isAck(a) && a.id === id && a.root === key)),
      { id, root: key, at: now.toISOString() },
    ]);
  }

  async remove(id: AckId, root: string): Promise<void> {
    const key = resolve(root);
    await this.#rewrite((items) => items.filter((a) => !(isAck(a) && a.id === id && a.root === key)));
  }

  /**
   * 読み直して書き換える。画面と CLI が同じファイルを触るので、書く直前に読み直す（同じプロセスの中は一列に並べる）。
   * 別のプロセス（画面と CLI）が同じ瞬間に書いた分は、後から書いた方が勝つ（読んでから書くまでの短い間。了解は「また出る」側にしか
   * 外れない）。
   *
   * - 読めない（EBUSY・EPERM が続く）: 書き換えずに投げる。空から書くと、それまでの了解を全部消す（前はそうしていた）
   * - 壊れている: 脇へ移してから（`acks.json.broken-<時刻>`）空で始める
   * - 知らない形の一件（新しい版が書いた等）は、書き直しても残す
   *
   * 書くのは一時ファイルから付け替える（`writeWhole`）。
   */
  #rewrite(change: (items: unknown[]) => unknown[]): Promise<void> {
    return inOrder(`${this.#file}#rewrite`, async () => {
      const r = await readJournal(this.#file, this.#ops);
      if (r.kind === 'unreadable') throw new Error(`了解の記録を読めないので、書き換えていません: ${this.#file}`);
      const items = r.kind === 'value' ? itemsOf(r.value) : [];
      // JSON としては読めても入れ物の形が違う（`null`・`acks` が配列でない）ときは、写しを脇に取ってから書く。中身を黙って消さない
      if (r.kind === 'value' && !hasItems(r.value)) {
        await copyFile(this.#file, `${this.#file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      }
      await mkdir(dirname(this.#file), { recursive: true });
      if (!await writeWhole(this.#file, `${JSON.stringify({ acks: change(items) }, null, 2)}\n`, this.#ops)) {
        throw new Error(`了解の記録を書けませんでした: ${this.#file}`);
      }
    });
  }
}

/** 入れ物が `{ acks: [...] }` の形か。 */
function hasItems(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Array.isArray((value as { acks?: unknown }).acks);
}

/** 記録の中の一件ずつ（形を問わず）。入れ物の形が違えば空。 */
function itemsOf(value: unknown): unknown[] {
  return hasItems(value) ? (value as { acks: unknown[] }).acks : [];
}

function isAck(a: unknown): a is Ack {
  return typeof a === 'object' && a !== null
    && isAckId((a as Ack).id) && typeof (a as Ack).root === 'string' && typeof (a as Ack).at === 'string';
}
