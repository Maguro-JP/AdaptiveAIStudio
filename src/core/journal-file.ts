/**
 * 丸ごと書き直す小さな JSON の記録（`idle.json`・`duties.json`）を、読む・書く。
 *
 * どちらも「読めなければ空で始めて、次の保存で上書きする」形だった。無いのは正常だが、
 * **在るのに読めない**（EBUSY・EPERM、壊れた JSON）ときにそうすると、それまでの実績を消す。
 * それに、その場で書いていたので、書いている途中で落ちると半分だけのファイルが残った。
 *
 * - 無い: 空で始める。
 * - 壊れている: `<名前>.broken-<時刻>` へ移してから空で始める。移せず写しも取れなければ、読めない扱い。
 * - 読めない: 空で始めるが、**保存の前に読み直す**。読めたら、その間に増えた分を上に足して書く。
 *   まだ読めなければ書かない。
 * - 書く: 一時ファイルに書いてから名前を付け替える。同じファイルへは一列に並べる。
 */
import { readFile, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import { inOrder } from './in-order.ts';
import { withFileLock } from './file-lock.ts';

export type JournalRead =
  | { kind: 'value'; value: unknown }
  /** `broken`: 壊れていたので脇へ移した（無かったのではない）。黙って既定に戻さず、そう言うため。 */
  | { kind: 'missing'; broken?: true }
  | { kind: 'unreadable' };

export interface JournalOps {
  /** 試験では、読む・脇へ移すを別のものにする。 */
  read?: (path: string) => Promise<string>;
  setAside?: (path: string) => Promise<boolean>;
  /** 一時ファイルへ書く。 */
  write?: (tmp: string, text: string) => Promise<void>;
  /** 一時ファイルを付け替える。 */
  rename?: (from: string, to: string) => Promise<void>;
}

export async function readJournal(path: string, ops: JournalOps = {}): Promise<JournalRead> {
  const read = ops.read ?? ((p: string) => readFile(p, 'utf8'));
  let text: string;
  for (let tries = 0; ; tries++) {
    try {
      text = await read(path);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing' };
      if (tries >= 3 || !(code === 'EBUSY' || code === 'EPERM')) return { kind: 'unreadable' };
      await new Promise((r) => setTimeout(r, 100 * (tries + 1)));
    }
  }
  try {
    return { kind: 'value', value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch {
    return await (ops.setAside ?? setAside)(path) ? { kind: 'missing', broken: true } : { kind: 'unreadable' };
  }
}

/** 壊れたファイルを脇へ移す。移せなければ写しを取る。どちらもできなければ false。 */
async function setAside(path: string): Promise<boolean> {
  const to = `${path}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { await rename(path, to); return true; } catch { /* 下で写しを取る */ }
  try { await copyFile(path, to); return true; } catch { return false; }
}

/** 読み込んだ入れ物のうち、ファイルが読めなかったもの。値はそのファイル。 */
const unread = new WeakMap<object, string>();

/** 入れ物ごとの、最後に読んだ・書いたファイルの中身（`saveMerged` が、ほかが書いた分を見分けるため）。 */
const lastSeen = new WeakMap<object, { path: string; text: string; value: unknown }>();

/**
 * 見た中身を覚える。**写しを持つ。**読んだ値をそのまま持つと、`restore` が同じ値を入れ物へ入れるので、手元で数えるたびに
 * 「前に見た中身」も一緒に増え、ほかが書いた回の差から手元の分を引いて消していた。
 */
function remember(target: object, path: string, value: unknown): void {
  const text = JSON.stringify(value);
  lastSeen.set(target, { path, text, value: JSON.parse(text) as unknown });
}

/** 読んで渡す。読めなかったときは覚えておき、保存の前に読み直す。 */
export async function loadJournal(
  target: object, path: string, apply: (value: unknown) => void, ops: JournalOps = {},
): Promise<JournalRead['kind']> {
  const r = await readJournal(path, ops);
  if (r.kind === 'value') {
    apply(r.value);
    remember(target, path, r.value);
  } else {
    lastSeen.delete(target);
  }
  if (r.kind === 'unreadable') unread.set(target, path);
  else unread.delete(target); // 読み直して読めたなら、次の保存で読み直して二重に足さない
  return r.kind; // 読めなかったかを、呼んだ側が振る舞いに使えるように（前が分からないときに「変わった」と言わない等）
}

let tmpSeq = 0;

/**
 * 書く。起動のときに読めなかったなら先に読み直し、読めたら `absorb` に渡してから書く（空で始めた間に
 * 増えた分と、ファイルにあった分を足す）。まだ読めなければ書かずに false。
 */
export function saveJournal(
  target: object, path: string, text: () => string,
  absorb: (value: unknown) => void, ops: JournalOps = {},
): Promise<boolean> {
  return inOrder(path, async () => {
    if (unread.get(target) === path) {
      const r = await readJournal(path, ops);
      if (r.kind === 'unreadable') return false;
      if (r.kind === 'value') absorb(r.value);
      unread.delete(target);
    }
    return replaceWhole(path, text(), ops);
  });
}

/**
 * 別のプロセスも書くファイルを書く（画面と端末が別々に持つ `idle.json`・`duties.json`）。
 *
 * `saveJournal` は手元を丸ごと書くので、もう一方が書いた分を後から書いた方が消した（済ませた当番がもう一度
 * 「やるべき」に戻る、数えた実績が減る）。ここでは、ほかのプロセスとの錠を持ったまま、**毎回読み直す**。
 * 中身が前に読んだ・書いたときと違えば、ほかが書いたものとして `rebase(ファイル, 前に見た中身)` に渡し、
 * 手元へ足してから書く。前に見た中身が無い（無かった・読めなかった）ときは `undefined` を渡す
 * （ファイルにある分を全部、ほかが書いた分として足す。起動のときに読めなかったときの扱いと同じ）。
 *
 * 読めなければ書かずに false。錠を取れないときも false（黙って上書きしない）。
 */
export function saveMerged(
  target: object, path: string, text: () => string,
  rebase: (value: unknown, base: unknown) => void, ops: JournalOps = {},
): Promise<boolean> {
  return inOrder(path, () => withFileLock(path, async () => {
    const r = await readJournal(path, ops);
    if (r.kind === 'unreadable') return false;
    const seen = lastSeen.get(target);
    const base = seen?.path === path ? seen : undefined;
    if (r.kind === 'value' && JSON.stringify(r.value) !== base?.text) {
      rebase(r.value, base?.value);
      // 足した分は、書けなくても手元に入っている。次の保存で同じ差をもう一度足さないよう、いまのファイルを見たことにする
      remember(target, path, r.value);
    }
    unread.delete(target);
    const out = text();
    if (!await replaceWhole(path, out, ops)) return false;
    remember(target, path, JSON.parse(out));
    return true;
  }).catch(() => false));
}

/** 一時ファイルに書いてから名前を付け替える。並びは呼ぶ側が決める。 */
async function replaceWhole(path: string, text: string, ops: JournalOps): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`; // 同じプロセスで並んで呼ばれても名前をぶつけない
  try {
    await (ops.write ?? ((t: string, x: string) => writeFile(t, x, 'utf8')))(tmp, text);
    // Windows では、ウイルス対策や索引作りが付け替え先を一瞬掴むと EPERM・EBUSY になる。少し待って付け替え直す
    for (let tries = 0; ; tries++) {
      try {
        await (ops.rename ?? rename)(tmp, path);
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (tries >= 3 || !(code === 'EPERM' || code === 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, 100 * (tries + 1)));
      }
    }
  } catch {
    await unlink(tmp).catch(() => undefined);
    return false;
  }
}

/**
 * 利用者が選んだものを丸ごと書く（画面の並び・見た目）。読み直して足すものが無いので、起動のときに読めたかどうかは見ない。
 * 同じファイルへは一列に並べ、一時ファイルから付け替える（途中で落ちても前の中身が残る）。書けなければ false。
 */
export function writeWhole(path: string, text: string, ops: JournalOps = {}): Promise<boolean> {
  return inOrder(path, () => replaceWhole(path, text, ops));
}
