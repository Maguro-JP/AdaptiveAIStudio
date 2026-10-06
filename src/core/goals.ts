/**
 * 段取り — 一つの依頼を、歩ける大きさの段に割って、一段ずつ進む。
 *
 * ここまで、依頼は**丸ごと一回で**モデルへ渡していた。分解する仕組み
 * （PM）はあるが、一度きり。落ちたら同じ大きさで挑み直し、三回やって
 * 諦める。**通らなかったものを、もう一度そのまま渡しても通らない。**
 *
 * ここが違う。**落ちたら、その段をもっと小さく割り直す。**
 *
 *   「src/a.ts の型を直して」          落ちた
 *     → 「src/a.ts を読む」            割り直し
 *     → 「12行目の型を string にする」
 *     → 「npm test を走らせる」
 *
 * 割り直しても落ちるなら、その段は**塞がった**ものとして脇へ置き、
 * **次の段へ進む**。一段で全部を止めない。止めると、独立して進められる
 * 残りまで道連れになる。
 *
 * 段はファイルに残す。画面を閉じても、機械を落としても続きから進む。
 */
import { readFile, appendFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { idMaker } from './ordered-id.ts';
import { inOrder } from './in-order.ts';
import { keptOdd } from './odd-lines.ts';
import { isAbsent } from '../harness/put-back.ts';

const makeId = idMaker('g');
let tmpSeq = 0;

/**
 * 記録を畳む行数。追記式なので、閉じた段取りの行も残り続け、読むたびに全部を解く。
 * これを超えたら、開いているものだけで書き直す。
 */
export const COMPACT_AFTER_LINES = 400;

/** 段の状態。**符丁で持つ。** */
export type StepState = 'pending' | 'done' | 'blocked' | 'split';

export interface Step {
  id: string;
  instruction: string;
  state: StepState;
  /** 何回やって落ちたか。 */
  attempts: number;
  /** 割り直して出来た段なら、元の段。 */
  parent?: string;
}

export interface Goal {
  id: string;
  /** 元の依頼。**そのまま残す。** */
  request: string;
  steps: Step[];
  createdAt: string;
}

/** 一つの段を、何回やって駄目なら割り直すか。 */
export const SPLIT_AFTER = 2;

/**
 * 割り直すのは**一度だけ**。**際限なく割らない。**
 *
 * 割った先がまた駄目なら、それは大きすぎるのではなく、
 * **そもそも出来ない**（前提が足りない、道具が無い、読み違えている）。
 * さらに割ると、意味の無い断片が増えるだけで、どれも通らない。
 */
export const MAX_DEPTH = 1;

type Line =
  | { t: 'goal'; goal: Goal }
  | { t: 'state'; goalId: string; stepId: string; state: StepState; attempts: number }
  | { t: 'split'; goalId: string; stepId: string; steps: Step[] }
  | { t: 'close'; goalId: string };

/** どうするか。**呼ぶ側が判じない。**ここで決めて、符丁で返す。 */
export type FailAction =
  | { do: 'retry'; attempts: number }
  | { do: 'split'; attempts: number }
  | { do: 'block'; attempts: number };

export class Goals {
  readonly #path: string;

  /** 試験で読む手をモックにするためのもの。 */
  readonly #readText: (path: string) => Promise<string>;

  constructor(path: string, ops: { read?: (path: string) => Promise<string> } = {}) {
    this.#path = path;
    this.#readText = ops.read ?? ((p) => readFile(p, 'utf8'));
  }

  async #append(line: Line): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    // 読めないときは区切りを入れる（空行は読むときに飛ばす）。「無い」と読んで入れないと、半端な行と繋がって両方読めなくなる
    const raw = await this.#readText(this.#path).catch((e: unknown) => (isAbsent(e) ? '' : undefined));
    const sep = raw === undefined ? '\n' : raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
    await appendFile(this.#path, `${sep}${JSON.stringify(line)}\n`, 'utf8');
  }

  /** いま開いているもの。古い順。 */
  async list(): Promise<Goal[]> {
    return parseGoals(await this.#readText(this.#path).catch(() => '')).open;
  }

  /** 段取りを立てる。 */
  open(request: string, instructions: string[], now = Date.now()): Promise<Goal> {
    return inOrder(this.#path, async () => {
      const goal = await this.#open(request, instructions, now);
      // 畳みは片づけにすぎない。段取りはもう書けているので、畳めなくても立てたことは返す（次に立てるときにまた畳む）。
      // 投げると、書けているのに「立てられなかった」になり、畳めない間は新しい段取りを一つも立てられなくなる。
      await this.#compact().catch(() => undefined);
      return goal;
    });
  }

  async #open(request: string, instructions: string[], now: number): Promise<Goal> {
    // 同じミリ秒に二つ立てても、名前をぶつけない（ぶつかると後の段取りが前のものを置き換える）。
    const id = makeId(now);
    const goal: Goal = {
      id,
      request,
      createdAt: new Date(now).toISOString(),
      steps: instructions.map((instruction, i) => ({
        id: `${id}-${i}`, instruction, state: 'pending' as const, attempts: 0,
      })),
    };
    await this.#append({ t: 'goal', goal });
    return goal;
  }

  /**
   * いま開いているもの。**読めなければ投げる**（無いだけなら空）。
   *
   * `list` は読めないと空を返す（見せるだけの所向け）。段を進める所がそれを使うと、読めないだけなのに
   * 「段が残っていない」と読んで段取りを閉じ、やり残しを「済んだ」にしていた。
   */
  async openGoals(): Promise<Goal[]> {
    let raw: string;
    try {
      raw = await this.#readText(this.#path);
    } catch (e) {
      if (!isAbsent(e)) throw e;
      raw = '';
    }
    return parseGoals(raw).open;
  }

  /** 次に手を付ける段。無ければ undefined。記録を読めなければ投げる（「無い」と取り違えない）。 */
  async next(goalId: string): Promise<Step | undefined> {
    const goal = (await this.openGoals()).find((g) => g.id === goalId);
    return goal?.steps.find((s) => s.state === 'pending');
  }

  succeed(goalId: string, stepId: string): Promise<void> {
    return inOrder(this.#path, () => this.#succeed(goalId, stepId));
  }

  async #succeed(goalId: string, stepId: string): Promise<void> {
    const goal = (await this.list()).find((g) => g.id === goalId);
    const step = goal?.steps.find((s) => s.id === stepId);
    await this.#append({ t: 'state', goalId, stepId, state: 'done', attempts: step?.attempts ?? 0 });
  }

  /**
   * 落ちた。**次にどうするかを、ここで決める。**
   *
   * 一度目は、そのままもう一度（届かなかっただけ、ということがある）。
   * 二度目で割り直す。割り直した先がまた駄目なら、塞がったとして脇へ置く。
   */
  fail(goalId: string, stepId: string): Promise<FailAction> {
    // 回数を読んで一つ足して書く。並んで走ると、二回落ちたのを一回と数える。
    return inOrder(this.#path, () => this.#fail(goalId, stepId));
  }

  async #fail(goalId: string, stepId: string): Promise<FailAction> {
    // 読めないときは投げる。空と読むと「段取りが無い」になり、一度読めなかっただけで段を塞いでいた（やり残しごと諦める道へ進む）
    const goal = (await this.openGoals()).find((g) => g.id === goalId);
    const step = goal?.steps.find((s) => s.id === stepId);
    if (!goal || !step) return { do: 'block', attempts: 0 };
    const attempts = step.attempts + 1;

    const depth = depthOf(goal, step);
    if (attempts < SPLIT_AFTER) {
      await this.#append({ t: 'state', goalId, stepId, state: 'pending', attempts });
      return { do: 'retry', attempts };
    }
    if (depth >= MAX_DEPTH) {
      // これ以上は割らない。割った先をさらに割ると、意味の無い断片になる。
      await this.#append({ t: 'state', goalId, stepId, state: 'blocked', attempts });
      return { do: 'block', attempts };
    }
    await this.#append({ t: 'state', goalId, stepId, state: 'pending', attempts });
    return { do: 'split', attempts };
  }

  /** 割り直す。元の段のすぐ後ろへ差し込む。 */
  split(goalId: string, stepId: string, instructions: string[]): Promise<Step[]> {
    return inOrder(this.#path, () => this.#split(goalId, stepId, instructions));
  }

  async #split(goalId: string, stepId: string, instructions: string[]): Promise<Step[]> {
    const steps: Step[] = instructions.map((instruction, i) => ({
      id: `${stepId}.${i}`, instruction, state: 'pending' as const, attempts: 0, parent: stepId,
    }));
    await this.#append({ t: 'split', goalId, stepId, steps });
    return steps;
  }

  /** その段は塞がった。**次の段へ進む**（一段で全部を止めない）。 */
  block(goalId: string, stepId: string): Promise<void> {
    return inOrder(this.#path, () => this.#block(goalId, stepId));
  }

  async #block(goalId: string, stepId: string): Promise<void> {
    const goal = (await this.list()).find((g) => g.id === goalId);
    const step = goal?.steps.find((s) => s.id === stepId);
    await this.#append({ t: 'state', goalId, stepId, state: 'blocked', attempts: step?.attempts ?? 0 });
  }

  close(goalId: string): Promise<void> {
    return inOrder(this.#path, () => this.#append({ t: 'close', goalId }));
  }

  /**
   * 元の依頼がもう「やり残し」に無い段取りを閉じる（閉じた数を返す）。
   *
   * 段取りを閉じるのは、段が尽きたときだけだった。利用者がやり残しを取り消した・諦めた・溜めすぎで落とした場合は、
   * 段取りが開いたまま残り、畳んでも減らず、同じ依頼をもう一度頼むと古い段取りの続きから始めていた。
   */
  retain(liveRequests: ReadonlySet<string>): Promise<number> {
    return inOrder(this.#path, async () => {
      let closed = 0;
      for (const goal of await this.list()) {
        if (liveRequests.has(goal.request)) continue;
        await this.#append({ t: 'close', goalId: goal.id });
        closed += 1;
      }
      return closed;
    });
  }

  /**
   * 記録を畳む。閉じた段取りの行は読むたびに解くだけなので、開いているものの今の姿（割り直しも状態も
   * 入れた形）だけで書き直す。一時ファイルに書いてから置き換える（途中で落ちても、記録を丸ごと失わない）。
   */
  async #compact(): Promise<void> {
    // 一度だけ読み、読めた同じ中身から畳む。読めなければ畳まない（前は二度読み、二度目が一瞬読めないと空で書き戻して全部消した）
    let raw: string;
    try { raw = await this.#readText(this.#path); } catch { return; }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).length;
    if (lines <= COMPACT_AFTER_LINES) return;
    const { open: live, odd } = parseGoals(raw);
    // 別の版が書いた行は、元の文のまま残す（畳むたびに黙って捨てない）
    const body = live.map((goal) => `${JSON.stringify({ t: 'goal', goal })}\n`).join('') + keptOdd(odd).map((l) => `${l}\n`).join('');
    const tmp = `${this.#path}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      // 書き切ってから付け替える（付け替えだけが残って電源が落ちると、空や 0 で埋まった記録になり、開いている段取りが全部消えうる）
      await writeFile(tmp, body, { encoding: 'utf8', flush: true });
      await rename(tmp, this.#path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}

/** 記録の中身を解く。読めなかった行（壊れた・形の違う）は `odd` に元の文のまま返す。 */
function parseGoals(raw: string): { open: Goal[]; odd: string[] } {
  const odd: string[] = [];
  const open = new Map<string, Goal>();
  for (const text of raw.split('\n')) {
    if (text.trim().length === 0) continue;
    let line: Line;
    try { line = JSON.parse(text) as Line; } catch { odd.push(text); continue; } // 壊れた行は読み飛ばす
    // 形の違う行（`null`・手で直した・別の版が書いた）も読み飛ばす。通すと一覧ごと止まり、段取りが進まない。
    if (!isLine(line)) { odd.push(text); continue; }
    if (line.t === 'goal') { open.set(line.goal.id, line.goal); continue; }
    const goal = open.get(line.goalId);
    if (!goal) continue;
    if (line.t === 'close') { open.delete(line.goalId); continue; }
    if (line.t === 'state') {
      const step = goal.steps.find((s) => s.id === line.stepId);
      if (step) { step.state = line.state; step.attempts = line.attempts; }
      continue;
    }
    // 割り直し。元の段の**すぐ後ろ**へ差し込む。前でも末尾でもない。
    // 順番が意味を持つ（読んでから書く、が入れ替わると通らない）。
    const at = goal.steps.findIndex((s) => s.id === line.stepId);
    if (at < 0) continue;
    goal.steps[at]!.state = 'split';
    goal.steps.splice(at + 1, 0, ...line.steps);
  }
  return { open: [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), odd };
}

/** 一行の形を確かめる。一覧と「次の段」で使う所まで見る。 */
function isLine(v: unknown): v is Line {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  if (l.t === 'goal') {
    const g = l.goal as Record<string, unknown> | null | undefined;
    return typeof g === 'object' && g !== null && typeof g.id === 'string' && typeof g.request === 'string'
      && typeof g.createdAt === 'string' && Array.isArray(g.steps) && g.steps.every(isStep);
  }
  if (typeof l.goalId !== 'string') return false;
  if (l.t === 'close') return true;
  // 製品が state の行に書くのは pending・done・blocked だけ（split は割り直しの行で表す）。
  // それ以外を通すと、壊れた行ひとつで「手を付ける段が無い＝終えた」になり、頼んだことを済みとして閉じる。
  if (l.t === 'state') return typeof l.stepId === 'string' && STATE_LINE.has(l.state as StepState) && isCount(l.attempts);
  if (l.t === 'split') return typeof l.stepId === 'string' && Array.isArray(l.steps) && l.steps.every(isStep);
  return false;
}

function isStep(v: unknown): v is Step {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === 'string' && typeof s.instruction === 'string' && STEP_STATES.has(s.state as StepState)
    && isCount(s.attempts) && (s.parent === undefined || typeof s.parent === 'string');
}

const STEP_STATES = new Set<StepState>(['pending', 'done', 'blocked', 'split']);
const STATE_LINE = new Set<StepState>(['pending', 'done', 'blocked']);

/** 回数。負の数を通すと、落ちても「もう一度」を返し続ける。 */
function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 何回割り直した先か。 */
function depthOf(goal: Goal, step: Step): number {
  let depth = 0;
  let at: Step | undefined = step;
  while (at?.parent) {
    depth += 1;
    at = goal.steps.find((s) => s.id === at!.parent);
  }
  return depth;
}

/** 進み具合。人に見せる。 */
export function progressOf(goal: Goal): { done: number; blocked: number; left: number; total: number } {
  // 割られた段そのものは数えない（中身の段で数える。二重に数えることになる）。
  const live = goal.steps.filter((s) => s.state !== 'split');
  return {
    done: live.filter((s) => s.state === 'done').length,
    blocked: live.filter((s) => s.state === 'blocked').length,
    left: live.filter((s) => s.state === 'pending').length,
    total: live.length,
  };
}

/** 全部片づいたか（塞がったものも「もう手を付けない」として数える）。 */
export function isSettled(goal: Goal): boolean {
  return progressOf(goal).left === 0;
}
