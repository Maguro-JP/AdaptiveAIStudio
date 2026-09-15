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
 * 段は置き場に残す。窓を閉じても、機械を落としても続きから進む。
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

  constructor(path: string) {
    this.#path = path;
  }

  async #append(line: Line): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const raw = await readFile(this.#path, 'utf8').catch(() => '');
    const sep = raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
    await appendFile(this.#path, `${sep}${JSON.stringify(line)}\n`, 'utf8');
  }

  /** いま開いているもの。古い順。 */
  async list(): Promise<Goal[]> {
    const raw = await readFile(this.#path, 'utf8').catch(() => '');
    const open = new Map<string, Goal>();
    for (const text of raw.split('\n')) {
      if (text.trim().length === 0) continue;
      let line: Line;
      try { line = JSON.parse(text) as Line; } catch { continue; } // 壊れた行は捨てる
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
    return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 段取りを立てる。 */
  async open(request: string, instructions: string[], now = Date.now()): Promise<Goal> {
    const id = `g${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
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

  /** 次に手を付ける段。無ければ undefined。 */
  async next(goalId: string): Promise<Step | undefined> {
    const goal = (await this.list()).find((g) => g.id === goalId);
    return goal?.steps.find((s) => s.state === 'pending');
  }

  async succeed(goalId: string, stepId: string): Promise<void> {
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
  async fail(goalId: string, stepId: string): Promise<FailAction> {
    const goal = (await this.list()).find((g) => g.id === goalId);
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
  async split(goalId: string, stepId: string, instructions: string[]): Promise<Step[]> {
    const steps: Step[] = instructions.map((instruction, i) => ({
      id: `${stepId}.${i}`, instruction, state: 'pending' as const, attempts: 0, parent: stepId,
    }));
    await this.#append({ t: 'split', goalId, stepId, steps });
    return steps;
  }

  /** その段は塞がった。**次の段へ進む**（一段で全部を止めない）。 */
  async block(goalId: string, stepId: string): Promise<void> {
    const goal = (await this.list()).find((g) => g.id === goalId);
    const step = goal?.steps.find((s) => s.id === stepId);
    await this.#append({ t: 'state', goalId, stepId, state: 'blocked', attempts: step?.attempts ?? 0 });
  }

  async close(goalId: string): Promise<void> {
    await this.#append({ t: 'close', goalId });
  }
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
