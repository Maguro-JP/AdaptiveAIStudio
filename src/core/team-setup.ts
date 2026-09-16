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

export interface TeamWiring {
  /** 依頼ごとのツール。規則を通ってから動く。 */
  toolsFor(item: WorkItem): Tool[];
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
): Promise<TeamWiring> {
  const harness = await buildHarness(config, onDecision);
  const bare: Tool[] = [
    readFileTool, listFilesTool, searchTextTool, findCodeTool, findSymbolTool,
    writeFileTool, editFileTool,
    createRunCommandTool({ allowed: config.agent?.allowedCommands }),
  ];
  const undo = new UndoStore(root, join(stateDir(), 'undo'));
  await undo.begin(`team ${root}`, now);
  return {
    // 履歴は依頼ごとに分ける。一つを使い回すと、読んでから書く規則が
    // **別の担当が読んだこと**で通ってしまう（`Harness.forTask()`）。
    toolsFor: (item) => harness.forTask().wrapAll(bare, () => item.instruction),
    beforeWrite: (path, previous) => undo.capture(path, previous),
    undo,
    harness,
    bare,
  };
}
