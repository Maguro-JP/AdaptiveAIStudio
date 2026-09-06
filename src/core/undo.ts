/**
 * 戻せるようにする。
 *
 * **これが無いと、手元の小さいモデルは使えない。**間違った直しを当てられた
 * とき、利用者にできることが「自分で書き戻す」しか無いなら、任せられない。
 * 一度そうなれば、次からは何を頼むにも身構えることになる。
 *
 * `src/harness/checkpoint.ts` は**一往復の中**の控えで、確かめて落ちたときに
 * 自動で戻すためのもの。終われば捨てる。ここはその逆で、**終わった後に、
 * 人が自分の判断で戻す**ためのもの。だから記録に残す。
 *
 * git がある置き場なら git が本来の安全網。ただし
 *   ・git 管理外の置き場がある（社用PCで git は入れられない）
 *   ・未コミットの直しは git でも戻せない
 * ので、git の有無に関わらず効くものを別に持つ。
 */
import { readFile, writeFile, mkdir, unlink, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeResolve } from '../agent/tools/paths.ts';

/** 一つの戻り先。 */
export interface UndoPoint {
  id: string;
  /** いつ（ミリ秒）。 */
  at: number;
  /** 何を頼んだときの直しか。人がどれに戻すか選ぶための手がかり。 */
  request: string;
  /** 触ったファイル（作業場からの相対）。 */
  paths: string[];
}

interface Saved {
  path: string;
  /** 元々無かったファイルは undefined。戻すときは消す。 */
  content?: string;
}

interface Stored extends UndoPoint {
  files: Saved[];
}

/**
 * 残す数。
 *
 * 多すぎると選べない。少なすぎると、気づいたときには消えている。
 * 一日分の作業（十数往復）が残る程度にする。
 */
export const MAX_POINTS = 30;

/**
 * 一つの戻り先に控える大きさの上限。
 *
 * 大きなファイルを丸ごと控えると、置き場が膨らむ。超えた分は控えないが、
 * **控えなかったことは言う**（戻せると思って戻せない、をなくす）。
 */
export const MAX_POINT_BYTES = 8 * 1024 * 1024;

export class UndoStore {
  readonly #root: string;
  readonly #dir: string;
  #open: { id: string; at: number; request: string; files: Map<string, Saved>; bytes: number; skipped: string[] } | undefined;
  /** 大きすぎて控えられなかったもの。黙って落とさないために持つ。 */
  #skipped: string[] = [];

  constructor(root: string, dir: string) {
    this.#root = root;
    this.#dir = dir;
  }

  /**
   * 一往復を始める。
   *
   * 前の一往復が閉じていなければ、そちらを先に閉じる。開きっぱなしにすると、
   * 別々の依頼の直しが一つの戻り先に混ざり、戻しすぎることになる。
   */
  async begin(request: string, now = Date.now()): Promise<void> {
    if (this.#open) await this.end();
    this.#open = {
      id: `u${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: now,
      request: request.split('\n')[0]?.slice(0, 120) ?? '',
      files: new Map(),
      bytes: 0,
      skipped: [],
    };
  }

  /**
   * 書き込む直前の中身を控える。同じファイルは最初の一度だけ。
   *
   * `previous` を受け取るのは、**書く側が既に読んでいるものを二度読まない**ため。
   */
  capture(relPath: string, previous: string | undefined): void {
    const open = this.#open;
    if (!open || open.files.has(relPath)) return;
    const size = previous?.length ?? 0;
    if (open.bytes + size > MAX_POINT_BYTES) {
      open.skipped.push(relPath);
      return;
    }
    open.bytes += size;
    open.files.set(relPath, { path: relPath, content: previous });
  }

  /** いまの一往復を閉じて、戻り先として残す。何も触っていなければ残さない。 */
  async end(): Promise<UndoPoint | undefined> {
    const open = this.#open;
    this.#open = undefined;
    if (!open) return undefined;
    this.#skipped = open.skipped;
    if (open.files.size === 0) return undefined;

    const point: Stored = {
      id: open.id,
      at: open.at,
      request: open.request,
      paths: [...open.files.keys()],
      files: [...open.files.values()],
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${point.id}.json`), JSON.stringify(point), 'utf8');
    await this.#prune();
    return { id: point.id, at: point.at, request: point.request, paths: point.paths };
  }

  /** 大きすぎて控えられなかったもの。読んだら空にする。 */
  takeSkipped(): string[] {
    const out = this.#skipped;
    this.#skipped = [];
    return out;
  }

  /** 戻り先の一覧。新しい順。 */
  async list(): Promise<UndoPoint[]> {
    const points: UndoPoint[] = [];
    for (const name of await readdir(this.#dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(this.#dir, name), 'utf8').catch(() => undefined);
      if (!raw) continue;
      try {
        const p = JSON.parse(raw) as Stored;
        if (typeof p.id === 'string') points.push({ id: p.id, at: p.at, request: p.request, paths: p.paths ?? [] });
      } catch { /* 1件壊れても全部は失わない */ }
    }
    return points.sort((a, b) => b.at - a.at);
  }

  /**
   * ここまで戻す。
   *
   * **選んだ一つだけを戻さない。**その後の直しが上に乗っているので、
   * 一つだけ戻すと、途中だけ古い、どこにも無かった状態になる。
   * 選んだ戻り先を含めて、それより新しいものを新しい方から順に当てる。
   */
  async restore(id: string): Promise<{ paths: string[]; points: number } | undefined> {
    const all = await this.list();
    const at = all.findIndex((p) => p.id === id);
    if (at === -1) return undefined;

    const touched: string[] = [];
    // 新しい方から当てる。古い控えが後に来るので、いちばん古い姿が残る。
    for (const point of all.slice(0, at + 1)) {
      const raw = await readFile(join(this.#dir, `${point.id}.json`), 'utf8').catch(() => undefined);
      if (!raw) continue;
      let stored: Stored;
      try { stored = JSON.parse(raw) as Stored; } catch { continue; }
      for (const saved of stored.files ?? []) {
        const abs = safeResolve(this.#root, saved.path);
        if (!abs) continue;
        try {
          if (saved.content === undefined) {
            if (await stat(abs).catch(() => undefined)) await unlink(abs);
          } else {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, saved.content, 'utf8');
          }
          if (!touched.includes(saved.path)) touched.push(saved.path);
        } catch { /* 1件戻せなくても他は戻す */ }
      }
      await unlink(join(this.#dir, `${point.id}.json`)).catch(() => undefined);
    }
    return { paths: touched, points: at + 1 };
  }

  /** 溜めすぎない。落とした数を返す。 */
  async #prune(max = MAX_POINTS): Promise<number> {
    const all = await this.list();
    if (all.length <= max) return 0;
    const drop = all.slice(max);
    for (const p of drop) await unlink(join(this.#dir, `${p.id}.json`)).catch(() => undefined);
    return drop.length;
  }
}
