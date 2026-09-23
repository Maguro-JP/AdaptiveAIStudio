/**
 * team（並列で複数の作業者を動かす道）の、ツールまわりの組み立て。
 *
 * **ここを別のファイルに出したのは、確かめられるようにするため。**
 * 入口（`src/cli/team.ts`）の中に書いていると、モデルを立てないと一度も
 * 通らない。組み立てだけを外に出せば、手元で押して確かめられる。
 */
import { join } from 'node:path';
import type { AasConfig } from '../config.ts';
import type { Tool } from '../agent/tools/types.ts';
import type { WorkItem } from '../agent/team.ts';
import type { Harness, HarnessDecision } from '../harness/harness.ts';
import { buildHarness } from './harness-setup.ts';
import { UndoStore } from './undo.ts';
import { stateDir } from './home.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool, editFileTool } from '../agent/tools/fs.ts';
import { findCodeTool, findSymbolTool } from '../agent/tools/find.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { RoleRegistry, toolsFor as toolsForRole } from '../roles/registry.ts';
import { buildSystemPrompt } from '../roles/role.ts';

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
  beforeWrite(path: string, previous: string | undefined): void;
  /** 一回ぶんの戻り先。終わったら `end()` で閉じる。 */
  undo: UndoStore;
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
): Promise<TeamWiring> {
  const harness = await buildHarness(config, onDecision);
  /*
   * 権限の区分ごとに分けて持つ。**役職はこの区分で絞る**（`roles/registry.ts`）。
   * 一枚に並べていたので、絞る手がどこにも無かった。
   * ここに `network` と `mcp` は無い。端末側では組んでいないので、
   * それらを持つ役職でも、その区分は空になる。
   */
  const pool = {
    read: [readFileTool, listFilesTool, searchTextTool, findCodeTool, findSymbolTool],
    write: [writeFileTool, editFileTool],
    execute: [createRunCommandTool({ allowed: config.agent?.allowedCommands })],
  };
  const bare: Tool[] = [...pool.read, ...pool.write, ...pool.execute];
  const roles = new RoleRegistry(config.roles ?? []);
  const undo = new UndoStore(root, join(stateDir(), 'undo'));
  await undo.begin(`team ${root}`, now);
  return {
    // 履歴は依頼ごとに分ける。一つを使い回すと、読んでから書く規則が
    // **別の担当が読んだこと**で通ってしまう（`Harness.forTask()`）。
    toolsFor: (item) => {
      const role = item.roleId ? roles.get(item.roleId) : undefined;
      return harness.forTask().wrapAll(role ? toolsForRole(role, pool) : bare, () => item.instruction);
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
        tools: harness.forTask().wrapAll(toolsForRole(role, pool), () => item.instruction),
      };
    },
    beforeWrite: (path, previous) => undo.capture(path, previous),
    undo,
    harness,
    bare,
  };
}
