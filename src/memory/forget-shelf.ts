/**
 * 画面の「忘れる」を、押し間違えても戻せる形にする。
 *
 * 忘れた覚えは、戻すためにしばらく手元に取っておく（`ForgetShelf`）。画面から戻すときは番号だけを受け取り、
 * 中身はここから出す。**中身を画面から送らせない。**送らせると、記憶（毎回の依頼に差し込まれる）へ
 * 任意の文を書き込める口になる。
 *
 * 保存に失敗したら、忘れていない（戻していない）ことにして返す。手元だけ忘れて「忘れました」と言うと、
 * 次に開いたときに戻ってきて、忘れたはずのものがなぜ在るのか分からなくなる。
 */
import type { Forgotten, Memory, RestoreRefusal } from './memory.ts';

/** 取っておく数。古いものから落とす（一日に何十も忘れる使い方は考えていない）。 */
const KEEP = 20;

export class ForgetShelf {
  readonly #items = new Map<string, Forgotten>();

  put(f: Forgotten): void {
    this.#items.delete(f.entry.id);
    this.#items.set(f.entry.id, f);
    while (this.#items.size > KEEP) this.#items.delete(this.#items.keys().next().value!);
  }

  take(id: string): Forgotten | undefined {
    const f = this.#items.get(id);
    this.#items.delete(id);
    return f;
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }
}

export type ForgetResult =
  | { ok: true; id: string; title: string }
  | { ok: false; status: number; error: string; /** 画面の「戻す」を、もう出さなくてよい（押しても戻らない） */ gone?: boolean };

const WHY_NOT: Record<RestoreRefusal, string> = {
  reloaded: '忘れた後に記憶を読み直したので、戻せません（番号が変わっています）',
  taken: '同じ番号の覚えが既に在るので、戻していません',
  duplicate: '同じ覚えを、忘れた後にもう一度覚えています。二つにしないよう、戻していません',
};

/**
 * 忘れて保存する。保存できなければ戻して、忘れていないと言う。
 *
 * 保存の途中で番号が振り直されたとき（読めなかったファイルが読めて、手元の分を後ろへ足した）は、手元へ戻せない
 * （同じ番号が別の覚えを指す）。そのときは、手元では忘れていて次の保存で書く、と本当のことを言う。
 */
export async function forgetAndSave(memory: Memory, shelf: ForgetShelf, id: string): Promise<ForgetResult> {
  const f = memory.remove(id);
  if (!f) return { ok: false, status: 404, error: `その覚えはありません: ${id}` };
  try {
    await memory.save();
  } catch (e) {
    const why = (e as Error).message;
    if (memory.restore(f) === true) return { ok: false, status: 500, error: `保存できなかったので、忘れていません（${why}）` };
    return { ok: false, status: 500, error: `保存できませんでした。手元では忘れていて、次に保存できたときに書きます（${why}）` };
  }
  // 保存の中で番号が振り直されていたら、取った分は戻せない（載せると、戻す口が別の覚えを指す）
  if (f.era === memory.era) shelf.put(f);
  return { ok: true, id, title: f.entry.title };
}

/** 忘れたものを戻して保存する。保存できなければ忘れたままにして、戻していないと言う。 */
export async function restoreAndSave(memory: Memory, shelf: ForgetShelf, id: string): Promise<ForgetResult> {
  const f = shelf.take(id);
  if (!f) return { ok: false, status: 404, gone: true, error: `戻せる覚えがありません（立ち上げ直すと、戻せる分は消えます）: ${id}` };
  const done = memory.restore(f);
  if (done !== true) return { ok: false, status: 409, gone: true, error: `${WHY_NOT[done]}: ${id}` };
  try {
    await memory.save();
  } catch (e) {
    const why = (e as Error).message;
    // 同じ代の間なら、戻した分を取り出して、もう一度押せるようにする。振り直された後は取り出す先が分からない
    if (f.era === memory.era && memory.remove(id)) {
      shelf.put(f);
      return { ok: false, status: 500, error: `保存できなかったので、戻していません（${why}）` };
    }
    return { ok: false, status: 500, gone: true, error: `保存できませんでした。手元では戻していて、次に保存できたときに書きます（${why}）` };
  }
  return { ok: true, id, title: f.entry.title };
}
