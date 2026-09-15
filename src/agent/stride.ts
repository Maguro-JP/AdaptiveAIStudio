/**
 * 歩幅 — そのモデルが、一歩でどこまでやれるか。
 *
 * ここまで、依頼の大きさは**人が決めたまま**モデルへ渡していた。
 * 外の大きなモデルならそれで通る。ローカルは通らない。
 *
 *   「src を直して」          4B には大きすぎる。読んだだけで力尽きる
 *   「src/a.ts の型を直して」 これなら通る
 *
 * そして**失敗したときに同じ大きさで挑み直していた**。
 * 通らなかったものを、もう一度そのまま渡しても通らない。
 * 三回やって諦める、を繰り返していた。
 *
 * だから測る。**言い訳ではなく、実際にこなせた跡で測る。**
 * 通ったら少しずつ広げ、落ちたらすぐ狭める。
 * 広げるのは慎重に（三回続けて通ってから）、狭めるのは即座に。
 * 落ちる方が高くつくので、対称にしない。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 歩幅。**符丁で持つ**（表示のときに日本語へ引き直す）。 */
export type StrideSize = 'tiny' | 'small' | 'medium' | 'large';

const ORDER: StrideSize[] = ['tiny', 'small', 'medium', 'large'];

/** 広げるのに要る連勝。狭めるのは1敗で。 */
const WIDEN_AFTER = 3;

/** 一歩の目安。分解させるときに、そのまま渡す。 */
const GUIDE: Record<StrideSize, { steps: number; text: string }> = {
  tiny: {
    steps: 8,
    text: '一歩は「1つのファイルの、1箇所の書き換え」まで。'
      + 'ファイルをまたがない。関数をまたがない。読むのと書くのを別の歩に分ける。',
  },
  small: {
    steps: 6,
    text: '一歩は「1つのファイルの、1つの関数」まで。ファイルをまたがない。',
  },
  medium: {
    steps: 4,
    text: '一歩は「1つのファイル」まで。まとめて2つ以上のファイルを触らない。',
  },
  large: {
    steps: 3,
    text: '一歩は「一まとまりの意味を持つ変更」まで。関係するファイルは一緒に触ってよい。',
  },
};

export interface StrideRecord {
  size: StrideSize;
  /** いま何連勝しているか。落ちたら 0 に戻る。 */
  streak: number;
  ok: number;
  ng: number;
}

/** 人に見せる言葉。**基幹には日本語を置かない。** */
export function strideText(size: StrideSize): string {
  switch (size) {
    case 'tiny': return '極小（1箇所ずつ）';
    case 'small': return '小さめ（1関数ずつ）';
    case 'medium': return '普通（1ファイルずつ）';
    case 'large': return '大きめ（まとまりごと）';
  }
}

/** その歩幅での、分解の目安。 */
export function guideFor(size: StrideSize): { steps: number; text: string } {
  return GUIDE[size];
}

/**
 * 一歩ぶんの結果を入れて、次の歩幅を出す。
 *
 * **狭めるのは即座に、広げるのは三回続けて通ってから。**
 * 落ちる方が高くつく（やり直しの時間も、壊れたものを戻す手間も）ので、
 * 対称にしない。
 */
export function nextStride(now: StrideRecord, ok: boolean): StrideRecord {
  const at = ORDER.indexOf(now.size);
  if (!ok) {
    return {
      size: ORDER[Math.max(at - 1, 0)]!,
      streak: 0,
      ok: now.ok,
      ng: now.ng + 1,
    };
  }
  const streak = now.streak + 1;
  if (streak < WIDEN_AFTER) return { ...now, streak, ok: now.ok + 1 };
  return {
    size: ORDER[Math.min(at + 1, ORDER.length - 1)]!,
    streak: 0,
    ok: now.ok + 1,
    ng: now.ng,
  };
}

/**
 * 最初の歩幅を、機械の側から見当をつける。
 *
 * **測る前の一回目にも、何かは要る。**窓の広さは、そのモデルが一度に
 * 抱えられる量そのものなので、いちばん素直な手がかりになる。
 * 見当が外れても、一回落ちれば狭まる。**外れる前提で置く。**
 */
export function firstStride(contextTokens: number): StrideSize {
  if (contextTokens >= 60_000) return 'large';
  if (contextTokens >= 24_000) return 'medium';
  if (contextTokens >= 8_000) return 'small';
  return 'tiny';
}

/** モデルごとの歩幅を、置き場に覚える。 */
export class StrideBook {
  readonly #path: string;
  #cache?: Record<string, StrideRecord>;

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<Record<string, StrideRecord>> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#cache = JSON.parse(raw) as Record<string, StrideRecord>;
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  /** いまの歩幅。まだ測っていなければ、窓の広さから見当をつける。 */
  async get(model: string, contextTokens: number): Promise<StrideRecord> {
    const all = await this.#load();
    return all[model] ?? { size: firstStride(contextTokens), streak: 0, ok: 0, ng: 0 };
  }

  /** 一歩ぶんの結果を入れる。**通った跡で測る。** */
  async record(model: string, contextTokens: number, ok: boolean): Promise<StrideRecord> {
    const all = await this.#load();
    const next = nextStride(await this.get(model, contextTokens), ok);
    all[model] = next;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(all, null, 2), 'utf8');
    return next;
  }

  /** 覚えている分ぜんぶ。画面に出す。 */
  async all(): Promise<Record<string, StrideRecord>> {
    return { ...(await this.#load()) };
  }
}
