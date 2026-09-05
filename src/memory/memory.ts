/**
 * 記憶 — この場所に住み続けるための器。
 *
 * 起動するたびに何も覚えていないなら、それは道具であって住人ではない。
 * 決めたこと、試して駄目だったこと、調べて分かったこと、
 * 利用者の好み —— これが残らない限り、同じ失敗を無限に繰り返す。
 *
 * 設計で外せない点が三つある。
 *
 *   1. **確度は回数で上がる**
 *      一度見たことは仮説、何度も確かめられたことは事実に近い。
 *      同じことを覚え直したら、上書きではなく確認回数を増やす。
 *
 *   2. **決め直しは消さずに繋ぐ**
 *      古い決定を消すと「なぜ変えたのか」が失われる。
 *      新しい決定から古い決定へ矢印を張り、履歴として残す。
 *
 *   3. **矛盾は黙って飲み込まない**
 *      前と違うことを決めたなら、それは報告に値する出来事。
 *
 *   4. **役に立ったかを見る**
 *      思い出して添えた結果、その仕事が通ったのか、落ちたのか。
 *      見ないと、**外れた覚えが永遠に効き続ける**。使うほど雑音が増える形で、
 *      それは「使うほど馬鹿になる」。当たった覚えを上げ、外した覚えを下げる。
 *
 *      ただし**確かめていない回からは学ばない。**検証を回していない回の
 *      「うまくいった気がする」で重みを動かすと、思い込みが固まるだけ。
 *
 * 埋め込みも外部データベースも使わない。語の重なりと新しさと確認回数で十分に効く。
 * 動く条件を増やさないことも、止まらないための設計のうち。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { jstDate } from '../core/clock.ts';

export type MemoryKind =
  /** 決めたこと。方針・設計判断 */
  | 'decision'
  /** 試したこと。うまくいった/駄目だった */
  | 'attempt'
  /** 調べて分かったこと */
  | 'fact'
  /** 利用者の好み・流儀 */
  | 'preference'
  /** 起きたこと。障害・事故 */
  | 'incident'
  /**
   * 嫌がられたこと。
   *
   * **これだけは、話題が違っても必ず思い出す。**語の重なりで引くと、
   * 画面の不快は画面の作業のときしか出てこない。踏む地雷は、
   * どの作業でも同じように踏む。
   *
   * **刈らない。**溜まっても数十件で、そのぶんの窓は払う価値がある。
   */
  | 'displeasure';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** 一行で。あとで探すときの手がかりになる。 */
  title: string;
  detail: string;
  tags: string[];
  /** 最初に覚えた時刻 */
  at: number;
  /** 最後に確かめられた時刻 */
  seenAt: number;
  /** 何度確かめられたか。1 は仮説、重なるほど事実に近い。 */
  confirms: number;
  /** attempt のみ */
  outcome?: 'worked' | 'failed';
  /** どこで知ったか */
  source?: string;
  /** 思い出して添えた回数。 */
  used?: number;
  /** 添えたあと、確かめて通った回数。 */
  helped?: number;
  /** 添えたあと、確かめて落ちた回数。 */
  misled?: number;
  /** この決定が置き換えた古い決定 */
  supersedes?: string;
  /** 置き換えられた側に入る */
  supersededBy?: string;
}

export interface RecallOptions {
  limit?: number;
  kinds?: MemoryKind[];
  /** 置き換えられた古い決定も含める */
  includeSuperseded?: boolean;
}

/** 覚え直したときに何が起きたか。呼び出し側が周知に使う。 */
export interface RememberResult {
  entry: MemoryEntry;
  /** 初めて覚えた */
  isNew: boolean;
  /** 同じことを再び確かめた（確度が上がった） */
  reinforced: boolean;
  /** 前と食い違う決定。黙って飲み込まない。 */
  conflicts: MemoryEntry[];
}

const STOP = new Set([
  'する', 'した', 'して', 'ある', 'ない', 'こと', 'もの', 'ため', 'よう',
  'the', 'a', 'an', 'is', 'to', 'of', 'and', 'in', 'for', 'on', 'with', 'it',
]);

/**
 * 語に割る。日本語は語の切れ目が無いので、
 * 記号と英数の境目で割り、2文字以上の塊を拾う。
 * 形態素解析は入れない。依存を増やしてまでの精度差が無い。
 */
export function tokenize(text: string): string[] {
  const rough = text
    .toLowerCase()
    .replace(/[「」『』（）()[\]{}、。,.:;!?？！\-_/\\'"`|+*=<>~@#$%^&\n\r\t]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const out: string[] = [];
  for (const chunk of rough) {
    if (/^[\x20-\x7e]+$/.test(chunk)) {
      if (chunk.length >= 2 && !STOP.has(chunk)) out.push(chunk);
      continue;
    }
    // 日本語は2文字ずつずらして拾う。部分一致で引っかかるようにする。
    if (chunk.length <= 2) {
      if (!STOP.has(chunk)) out.push(chunk);
      continue;
    }
    for (let i = 0; i + 2 <= chunk.length; i += 1) {
      const gram = chunk.slice(i, i + 2);
      if (!STOP.has(gram)) out.push(gram);
    }
  }
  return out;
}

/** 同じことを言っているかの判定用。表記揺れを潰す。 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '').replace(/[。、,.!?！？]/g, '');
}

const DAY = 86_400_000;

export class Memory {
  readonly #path?: string;
  #entries: MemoryEntry[] = [];
  #seq = 0;
  #dirty = false;

  constructor(path?: string) {
    this.#path = path;
  }

  get size(): number {
    return this.#entries.length;
  }

  all(): MemoryEntry[] {
    return [...this.#entries];
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#entries = raw.split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try { return JSON.parse(l) as MemoryEntry; } catch { return undefined; }
        })
        // 1行壊れても記憶全体を失わない。JSONL にしているのはこのため。
        .filter((e): e is MemoryEntry => !!e && typeof e.id === 'string');
      this.#seq = this.#entries.length;
    } catch {
      this.#entries = [];
    }
  }

  async save(): Promise<void> {
    if (!this.#path || !this.#dirty) return;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, this.#entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.#dirty = false;
  }

  /**
   * 覚える。
   * 同じことを既に覚えていれば、上書きではなく確認回数を増やす。
   * 何度も確かめられたことほど、思い出されやすくなる。
   */
  remember(input: {
    kind: MemoryKind;
    title: string;
    detail?: string;
    tags?: string[];
    outcome?: 'worked' | 'failed';
    source?: string;
    supersedes?: string;
    now?: number;
  }): RememberResult {
    const now = input.now ?? Date.now();
    const title = input.title.trim();
    const key = normalizeTitle(title);

    const existing = this.#entries.find(
      (e) => e.kind === input.kind && normalizeTitle(e.title) === key && !e.supersededBy,
    );

    if (existing) {
      existing.confirms += 1;
      existing.seenAt = now;
      // 詳しい話が増えたなら受け取る。減らしはしない。
      if (input.detail && input.detail.length > existing.detail.length) existing.detail = input.detail;
      for (const t of input.tags ?? []) if (!existing.tags.includes(t)) existing.tags.push(t);
      if (input.outcome) existing.outcome = input.outcome;
      this.#dirty = true;
      return { entry: existing, isNew: false, reinforced: true, conflicts: [] };
    }

    this.#seq += 1;
    const entry: MemoryEntry = {
      id: `m${this.#seq}`,
      kind: input.kind,
      title,
      detail: input.detail ?? '',
      tags: [...new Set(input.tags ?? [])],
      at: now,
      seenAt: now,
      confirms: 1,
      outcome: input.outcome,
      source: input.source,
      supersedes: input.supersedes,
    };

    // 決め直しは消さずに繋ぐ。なぜ変えたのかを失わないため。
    if (input.supersedes) {
      const old = this.#entries.find((e) => e.id === input.supersedes);
      if (old) old.supersededBy = entry.id;
    }

    const conflicts = entry.kind === 'decision' && !input.supersedes
      ? this.#contradicting(entry)
      : [];

    this.#entries.push(entry);
    this.#dirty = true;
    return { entry, isNew: true, reinforced: false, conflicts };
  }

  /**
   * 前の決定と食い違っていないか。
   * 同じ話題（tag が重なる）で、まだ生きている別の決定を挙げる。
   * 食い違いかどうかの最終判断は人がする。ここは見つけて出すまで。
   */
  #contradicting(entry: MemoryEntry): MemoryEntry[] {
    if (entry.tags.length === 0) return [];
    return this.#entries.filter((e) =>
      e.kind === 'decision'
      && !e.supersededBy
      && e.id !== entry.id
      && e.tags.some((t) => entry.tags.includes(t))
      && normalizeTitle(e.title) !== normalizeTitle(entry.title));
  }

  /**
   * 思い出す。
   * 語の重なり・新しさ・確認回数で並べる。
   * 確認回数を効かせるのは、「一度きりの思いつき」より
   * 「何度も確かめられたこと」を先に出すため。
   */
  /**
   * 嫌がられたこと。**新しい順に。**
   * 話題に関係なく効くので、思い出すときは必ず先頭に付ける。
   */
  displeasures(limit = 12): MemoryEntry[] {
    return this.#entries
      .filter((e) => e.kind === 'displeasure')
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, limit);
  }

  recall(query: string, opts: RecallOptions = {}): MemoryEntry[] {
    const now = Date.now();
    const q = new Set(tokenize(query));
    const limit = opts.limit ?? 8;

    const scored = this.#entries
      .filter((e) => (opts.includeSuperseded ? true : !e.supersededBy))
      .filter((e) => (opts.kinds ? opts.kinds.includes(e.kind) : true))
      .map((e) => {
        // 触ったものも語に割る。`src/auth.ts` を丸ごと一語で持つと、
        // 「src/auth.ts を直す」と書いても重ならない（区切りで割れるため）。
        const words = new Set([
          ...tokenize(e.title), ...tokenize(e.detail),
          ...e.tags.map((t) => t.toLowerCase()), ...e.tags.flatMap((t) => tokenize(t)),
        ]);
        let overlap = 0;
        for (const t of q) if (words.has(t)) overlap += 1;
        // 話題が全く重ならないものは思い出さない。雑音になるだけ。
        if (overlap === 0 && q.size > 0) return undefined;

        /*
         * **成功と失敗を、同じ引き方にしない。**
         *
         *   成功は、その場の事情込みで成り立っている。他所へ持ち出すと外れる。
         *   失敗は、やってはいけない形なので、場所が変わっても効く。
         *
         * だから成功には**近いことの証拠**を要求し（語が二つ以上重なるか、
         * 触ったものが同じか）、失敗は一つ掠っただけでも拾う。
         * ここを対称にしていたので、うまくいった手が別の場所へ流れ出て、
         * 「その手しか取らない」を作っていた。
         */
        const sameGround = overlap >= 2 || e.tags.some((t) => q.has(t.toLowerCase()));
        if (transfersOnlyNearby(e) && q.size > 0 && !sameGround) return undefined;

        const ageDays = (now - e.seenAt) / DAY;
        const recency = 1 / (1 + ageDays / 30);
        const trust = Math.log2(1 + e.confirms);
        // 決めたことと好みは、古くても効き続ける
        const kindWeight = e.kind === 'decision' || e.kind === 'preference' ? 1.5 : 1;
        // 失敗は、遠くまで効く。同じ重なりなら、こちらを先に出す。
        const reach = carriesFar(e) ? 1.4 : 1;
        // **役に立ったかで重みを変える。**当たった覚えは上へ、外した覚えは下へ。
        // 一度も使っていないものは 1（下げも上げもしない）。
        return { e, score: (overlap * 2 + recency + trust) * kindWeight * reach * usefulness(e) };
      })
      .filter((x): x is { e: MemoryEntry; score: number } => !!x);

    scored.sort((a, b) => b.score - a.score || b.e.seenAt - a.e.seenAt);
    const hits = scored.slice(0, limit).map((x) => x.e);

    // **嫌がられたことは、話題に関係なく必ず混ぜる。**
    // 語が重ならないから外す、をやると、別の作業で同じ地雷を踏む。
    // 限度（limit）にも数えない。減らしてよい種類のものではない。
    if (opts.kinds && !opts.kinds.includes('displeasure')) return hits;
    const must = this.displeasures();
    const rest = hits.filter((e) => e.kind !== 'displeasure');
    return [...must, ...rest];
  }

  /**
   * 思い出して添えたことを控える。**添えた事実だけ**で、まだ良し悪しは付けない。
   */
  noteRecalled(ids: readonly string[]): void {
    for (const id of ids) {
      const e = this.#entries.find((x) => x.id === id);
      if (!e) continue;
      e.used = (e.used ?? 0) + 1;
      this.#dirty = true;
    }
  }

  /**
   * 添えた結果を書き戻す。
   *
   * **確かめていない回では呼ばない。**呼ぶ側が `passed` / `failed` を
   * 確かめてから渡す。確かめていない回で重みを動かすと、思い込みが固まる。
   */
  noteOutcome(ids: readonly string[], ok: boolean): void {
    for (const id of ids) {
      const e = this.#entries.find((x) => x.id === id);
      if (!e) continue;
      if (ok) e.helped = (e.helped ?? 0) + 1;
      else e.misled = (e.misled ?? 0) + 1;
      this.#dirty = true;
    }
  }

  /**
   * 同じことを前に試して駄目だったか。
   * これを見ずに始めるから、同じ失敗を繰り返す。
   */
  failedBefore(approach: string, limit = 3): MemoryEntry[] {
    return this.recall(approach, { kinds: ['attempt', 'incident'], limit: limit * 3 })
      .filter((e) => e.outcome !== 'worked')
      .slice(0, limit);
  }

  /**
   * 忘れる。
   *
   * **人が消せない記憶は、溜まる一方になる。**外れた覚えは重みで下がるが、
   * 「そもそも間違っている」と分かったものは、下げるのではなく消す。
   * 消したかどうかを返す（黙って何もしない、を作らない）。
   */
  forget(id: string): boolean {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.id !== id);
    // 繋がりも切っておく。消した先を指したままにすると、履歴が辿れなくなる。
    for (const e of this.#entries) {
      if (e.supersedes === id) delete e.supersedes;
      if (e.supersededBy === id) delete e.supersededBy;
    }
    const gone = this.#entries.length < before;
    if (gone) this.#dirty = true;
    return gone;
  }

  /** 決め直しの履歴を古い順に辿る。 */
  history(id: string): MemoryEntry[] {
    const chain: MemoryEntry[] = [];
    let cur = this.#entries.find((e) => e.id === id);
    while (cur) {
      chain.unshift(cur);
      const prev: string | undefined = cur.supersedes;
      cur = prev ? this.#entries.find((e) => e.id === prev) : undefined;
    }
    return chain;
  }

  /**
   * 記憶を刈る。
   * 決めたことと好みは残す。それが土台だから。
   * 一度しか見ていない古い事実から先に落とす。
   */
  compact(opts: { max?: number; now?: number } = {}): number {
    const max = opts.max ?? 500;
    if (this.#entries.length <= max) return 0;
    const now = opts.now ?? Date.now();

    // **嫌がられたことは刈らない。**忘れた瞬間に、同じ地雷を踏む。
    const isKeeper = (e: MemoryEntry) =>
      e.kind === 'decision' || e.kind === 'preference' || e.kind === 'displeasure' || !!e.supersededBy;
    const keep = this.#entries.filter(isKeeper);
    const rest = this.#entries.filter((e) => !isKeeper(e));

    // **効いた実績を、新しさより重く見る。**
    // 新しさと確認回数だけで刈ると、「今日覚えたばかりの外れ」が残り、
    // 「半年前から何度も効いている当たり」が消える。それは、使うほど
    // 手持ちが悪くなるということ。
    const worth = (e: MemoryEntry): number => {
      const base = Math.log2(1 + e.confirms) + 1 / (1 + (now - e.seenAt) / DAY / 30);
      // **失敗は長く持つ。**他所でも効くものを、その場限りのものと同じ速さで
      // 捨てない。うまくいった手は、その場の事情ごと古くなる。
      const reach = carriesFar(e) ? 1.5 : 1;
      return (base * usefulness(e) + (e.helped ?? 0) * 0.5 - (e.misled ?? 0) * 0.5) * reach;
    };
    rest.sort((a, b) => worth(b) - worth(a));

    const room = Math.max(0, max - keep.length);
    const dropped = rest.length - Math.min(rest.length, room);
    this.#entries = [...keep, ...rest.slice(0, room)].sort((a, b) => a.at - b.at);
    this.#dirty = true;
    return dropped;
  }
}

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: '決めたこと',
  attempt: '試したこと',
  fact: '分かったこと',
  preference: '好み',
  incident: '起きたこと',
  displeasure: '嫌がられたこと',
};

/**
 * 思い出した内容を、作業者に渡せる形にする。
 * 文脈は有限なので、短く、確度が分かる形で。
 */
export function formatRecall(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = [];

  // **嫌がられたことを、いちばん先に置く。**後ろに置くと、長い話に
  // 押されて末尾へ行き、取りこぼす。踏んではいけないものから読ませる。
  const hated = entries.filter((e) => e.kind === 'displeasure');
  if (hated.length > 0) {
    lines.push('二度としないこと（利用者が嫌がったこと。話題が違っても効きます）:');
    for (const e of hated) {
      lines.push(`  ・${e.title}`);
      if (e.detail) lines.push(`      利用者の言葉: ${e.detail.split('\n')[0]!.slice(0, 160)}`);
    }
    lines.push('');
  }

  const rest = entries.filter((e) => e.kind !== 'displeasure');
  if (rest.length === 0) return lines.join('\n').trimEnd();
  lines.push('これまでに分かっていること:');
  for (const e of rest) {
    // 確度を明示する。一度きりの話を事実として扱わせないため。
    const trust = e.confirms >= 3 ? '確か' : e.confirms === 2 ? 'おそらく' : '一度だけ';
    const mark = e.outcome === 'failed' ? '（失敗した）' : e.outcome === 'worked' ? '（うまくいった）' : '';
    lines.push(`  [${KIND_LABEL[e.kind]}/${trust}] ${e.title}${mark}`);
    if (e.detail) lines.push(`      ${e.detail.split('\n')[0]!.slice(0, 160)}`);
  }
  return lines.join('\n');
}

export function formatEntry(e: MemoryEntry): string {
  // UTC の日付を見せない。日本の朝 9 時まで昨日になる。
  const when = jstDate(e.seenAt);
  const trust = e.confirms > 1 ? ` ×${e.confirms}` : '';
  const dead = e.supersededBy ? ' （決め直し済み）' : '';
  return `  ${e.id} [${KIND_LABEL[e.kind]}${trust}] ${when} ${e.title}${dead}`;
}

/**
 * 役に立ち度。
 *
 * 添えたあと通った回数と、落ちた回数から出す。
 * **一度や二度で決めつけない**（Laplace）。使っていないものは 1 のまま。
 *
 *   まだ使っていない        → 1.00
 *   3回添えて3回通った      → 1.30
 *   3回添えて3回落ちた      → 0.70
 */
export function usefulness(e: Pick<MemoryEntry, 'helped' | 'misled'>): number {
  const helped = e.helped ?? 0;
  const misled = e.misled ?? 0;
  if (helped + misled === 0) return 1;
  // 0.5 を真ん中にして、0.6〜1.4 の幅に収める。効きすぎると
  // 一度の失敗で良い覚えが消える。
  const rate = (helped + 1) / (helped + misled + 2);
  return 0.6 + rate * 0.8;
}

/**
 * 他所でも効くもの。
 *
 * 「やってはいけない形」は場所に依らない。だから遠くまで持っていく。
 */
export function carriesFar(e: Pick<MemoryEntry, 'kind' | 'outcome'>): boolean {
  return e.kind === 'displeasure' || e.kind === 'incident' || e.outcome === 'failed';
}

/**
 * 近くでしか効かないもの。
 *
 * うまくいった手は、その場の事情込みで成り立っている。
 * 別の場所へ持ち出すと、たいてい外れる（しかも「その手しか取らない」を作る）。
 */
export function transfersOnlyNearby(e: Pick<MemoryEntry, 'kind' | 'outcome'>): boolean {
  return e.outcome === 'worked';
}
