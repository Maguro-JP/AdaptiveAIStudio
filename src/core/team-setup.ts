/**
 * team（並列で複数の作業者を動かす道）の、ツールまわりの組み立て。
 *
 * **ここを別のファイルに出したのは、確かめられるようにするため。**
 * 入口（`src/cli/team.ts`）の中に書いていると、モデルを立てないと一度も
 * 通らない。組み立てだけを外に出せば、手元で押して確かめられる。
 */
import type { ToolCall } from '../providers/contract.ts';
import { join } from 'node:path';
import type { AasConfig } from '../config.ts';
import type { Tool } from '../agent/tools/types.ts';
import type { WorkItem } from '../agent/team.ts';
import type { Harness, HarnessDecision } from '../harness/harness.ts';
import { buildHarness } from './harness-setup.ts';
import { UndoStore, type UndoPoint } from './undo.ts';
import { OutsideChanges, ToolWindows } from '../agent/outside-changes.ts';
import { stateDir } from './home.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool, editFileTool } from '../agent/tools/fs.ts';
import { findCodeTool, findSymbolTool } from '../agent/tools/find.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { RoleRegistry, toolsFor as toolsForRole } from '../roles/registry.ts';
import { buildSystemPrompt } from '../roles/role.ts';

/**
 * 作業指示書を読んで確かめる。読めない・形が違う・知らないレーンを指すなら、理由を一文にして投げる。
 * 入口はモデル（llama-server）を起こす前にこれを呼ぶ。起こした後で落ちると、Windows では llama-server が残る
 * （止める付き添いが無いので、VRAM と口を抱えたまま）。
 */
export function parseTasks(
  text: string, laneIds: readonly string[],
  /** 役職を知っているか。渡せば、知らない roleId を断る（素通しにすると、全部のツールで働かせてしまう）。 */
  knowsRole?: (roleId: string) => boolean,
): WorkItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`作業指示書を JSON として読めません: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error('作業指示書は作業の並び（[ ... ]）にしてください');
  const seen = new Set<string>();
  const strings = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  for (const item of raw as Partial<WorkItem>[]) {
    if (typeof item?.id !== 'string' || typeof item.instruction !== 'string' || typeof item.laneId !== 'string') {
      throw new Error(`作業に id・instruction・laneId が揃っていません: ${JSON.stringify(item)}`);
    }
    // 同じ id が二つあると、後の方は一度も走らず、数にも出ない（「完了 1/1」と出る）
    if (seen.has(item.id)) throw new Error(`タスクの id "${item.id}" が二つあります。別の id にしてください。`);
    seen.add(item.id);
    if (!laneIds.includes(item.laneId)) {
      throw new Error(`タスク "${item.id}" のレーン "${item.laneId}" が設定にありません。`);
    }
    // raceWith も確かめる。文字列で書くと一文字ずつに割れ、`l`・`o` をモデル名として走らせていた
    if (!strings(item.deps) || !strings(item.writes) || !strings(item.raceWith)) {
      throw new Error(`タスク "${item.id}" の deps・writes・raceWith は文字列の並びにしてください。`);
    }
    if (item.roleId !== undefined && (typeof item.roleId !== 'string' || (knowsRole && !knowsRole(item.roleId)))) {
      throw new Error(`タスク "${item.id}" の役職 "${String(item.roleId)}" がありません。`);
    }
  }
  return raw as WorkItem[];
}

export interface TeamWiring {
  /**
   * 依頼ごとのツール。規則を通ってから動く。
   *
   * **役職が付いていれば、ここでも絞る。**`assign` を渡し忘れても
   * 役職が守られるようにするため（Team は `assign` が無ければこちらに落ちる）。
   * 一箇所を直せば効く形にしておかないと、入口の渡し忘れが
   * 「直したつもり」のまま残る。
   */
  toolsFor(item: WorkItem): Tool[];
  /**
   * 役職ごとの決まりとツール。**役職が付いた依頼はこちらが絞る。**
   *
   * ここが無かったので、端末側は役職を見ずに全部のツールを配っていた
   * （画面側は `src/core/session.ts` で絞っている）。依頼ファイルに
   * `roleId` を書いても、読むだけの担当が書き込みも実行もできた。
   */
  assign(roleId: string, item: WorkItem): { system: string; tools: Tool[] } | undefined;
  /** 書き換える直前の中身を控える。**戻せるようにするため。** */
  beforeWrite(path: string, previous: string | Buffer | undefined): void;
  /** 一回ぶんの戻り先。終わったら `finish()` で閉じる（`end()` を直に呼ぶと run_command の分が載らない）。 */
  undo: UndoStore;
  /**
   * 終わりに呼ぶ。作業場を始めの記録と比べ、書くツールを通らずに変わった分（run_command）も
   * 戻り先に載せてから閉じる。`unrecorded` は、変わったが前の中身を記録できなかった道（戻せない。
   * 前後比べで取れなかったものも、大きさの上限で記録しなかったものも入る）。
   * `outsideLost` は、前後比べができなかったときの理由（落ちた・git で比べられなかった）。run_command で変わった分は
   * 一つも載っていない（戻せない）。
   */
  /**
   * `elsewhere` は、依頼の間に変わっていたが、書くツールも run_command も変えていない道（利用者が別の画面で保存した、など）。
   * 「戻す」には載せない（戻すと、その人が書いた分を消す）。
   */
  finish(): Promise<{ point: UndoPoint | undefined; unrecorded: string[]; outsideLost?: string; elsewhere?: string[] }>;
  harness: Harness;
  /** 素のツール。規則を通らない。画面に出す数え上げ用。 */
  bare: Tool[];
}

/**
 * team のツールを、ハーネスと戻り先に繋ぐ。
 *
 * **team はツールを素で渡していた。**一人で使う `aas` と画面は規則の手前で
 * 止まるのに、並列で動かすこの道だけ何も挟まっていなかった。守られた
 * ファイル（`.env`・lock・`.git`）も、作業場の外も、危ない命令も、断りの
 * 無い CI も、ここからは全部通った。**同時に何人も動くので、一人のときより
 * 取り返しがつきにくい。**書き換える前の控えも無く、戻す手が一つも無かった。
 */
export async function wireTeam(
  config: AasConfig,
  root: string,
  onDecision?: (d: HarnessDecision) => void,
  now = Date.now(),
  /**
   * 全員に共通の決まり文。役職の文は**後ろに足す**。
   * 前を全員で同じにしておくと、相手が頭から計算し直さずに済む。
   */
  baseSystem = '',
  /** 前後比べで前の中身を記録する上限。試験のために渡せる（既定は `OutsideChanges` の既定）。 */
  outsideLimits: { maxBytes?: number; maxTotalBytes?: number } = {},
): Promise<TeamWiring> {
  const harness = await buildHarness(config, onDecision);
  /*
   * 権限の区分ごとに分けて持つ。**役職はこの区分で絞る**（`roles/registry.ts`）。
   * 一枚に並べていたので、絞る手がどこにも無かった。
   * ここに `network` と `mcp` は無い。端末側では組んでいないので、
   * それらを持つ役職でも、その区分は空になる。
   */
  // run_command が走っている間に変わった道を覚える（終わりの前後比べで、利用者が書いた分を依頼の分と取り違えない）
  const windows = new ToolWindows(root);
  const pool = windows.pool({
    read: [readFileTool, listFilesTool, searchTextTool, findCodeTool, findSymbolTool],
    write: [writeFileTool, editFileTool],
    execute: [createRunCommandTool({ allowed: config.agent?.allowedCommands })],
  });
  const bare: Tool[] = [...pool.read, ...pool.write, ...pool.execute];
  const roles = new RoleRegistry(config.roles ?? []);
  const undo = new UndoStore(root, join(stateDir(), 'undo'));
  await undo.begin(`team ${root}`, now);
  /*
   * **run_command が変えた分も戻り先に載せる。**書くツールは書く手前で記録を取るが、run_command は
   * どこを書くか分からないので記録を取らない。段取り（`Session.plan`）と同じく、始めに作業場の記録を取り、
   * 終わりに前後を比べる。前後比べで分かった「前」は書く手前の記録より古い（依頼の前の姿）ので置き換える。
   */
  const outside = new OutsideChanges(root, outsideLimits);
  await outside.before();
  // 依頼全体の呼び出し。担当ごとの包みで共有し、「一つの依頼で何件まで書くか」を依頼全体で数える
  // （担当ごとの履歴だけで数えていたので、担当の数だけ上限が増えていた。段取りの道と同じ形にする）
  const taskHistory: ToolCall[] = [];
  return {
    // 履歴は依頼ごとに分ける。一つを使い回すと、読んでから書く規則が
    // **別の担当が読んだこと**で通ってしまう（`Harness.forTask()`）。
    toolsFor: (item) => {
      const role = item.roleId ? roles.get(item.roleId) : undefined;
      // 役職を名乗ったのに見つからない担当へ、全部のツールを渡さない（読むだけにする）。名乗っていない担当は今までどおり全部。
      const tools = role ? toolsForRole(role, pool) : item.roleId ? pool.read : bare;
      return harness.forTask(taskHistory).wrapAll(tools, () => item.instruction);
    },
    /*
     * 役職で絞ってから包む。**包みを外さない。**
     * 絞るだけにして素のツールを渡すと、規則の手前で止まらなくなる
     * （守られたファイルも作業場の外も通る）。順番はこの向きでなければならない。
     */
    assign: (roleId, item) => {
      const role = roles.get(roleId);
      if (!role) return undefined;
      return {
        system: baseSystem ? `${baseSystem}\n\n${buildSystemPrompt(role)}` : buildSystemPrompt(role),
        tools: harness.forTask(taskHistory).wrapAll(toolsForRole(role, pool), () => item.instruction),
      };
    },
    beforeWrite: (path, previous) => undo.capture(path, previous),
    undo,
    finish: async () => {
      // 前後比べが落ちても、書くツールの分の戻り先は閉じる。ただし run_command の分が載っていないことを黙らない
      // （黙ると、戻したつもりで run_command の変更だけ残る）
      const found = await outside.after().catch((e: unknown) => e as Error);
      const elsewhere: string[] = [];
      if (!(found instanceof Error)) {
        // 書くツールが書いたのでも、run_command が走っている間に変わったのでもない道は、依頼の分として載せない
        const ours = (path: string): boolean => undo.has(path) || windows.mayHaveTouched(path);
        for (const c of found.changes) {
          if (ours(c.path)) undo.replace(c.path, c.previous);
          else elsewhere.push(c.path);
        }
        for (const path of found.unrecorded) {
          if (ours(path)) undo.forget(path);
          else elsewhere.push(path);
        }
      }
      const point = await undo.end();
      // git が落ちた・git の管理下でないときは、after() は投げずに「比べられない」と返す。それも黙らない
      const lost = found instanceof Error ? found.message
        : found.comparable ? undefined : 'git で作業場の前後を比べられませんでした（git の管理下でない・git が動かない）';
      // 戻せないのは、前後比べで記録できなかった道だけではない。大きさで記録できなかった道も入れる。
      return {
        point, unrecorded: [...undo.peekSkipped()], ...(lost ? { outsideLost: lost } : {}),
        ...(elsewhere.length > 0 ? { elsewhere: elsewhere.sort() } : {}),
      };
    },
    harness,
    bare,
  };
}
