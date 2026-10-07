/**
 * 溜めておくもの（提案・当番・暇の配分）を、**セッションを作らずに読む。**
 *
 * ここは `Session.create` の中でしか組み立てられなかった。ところが
 * `Session.create` は、**モデルの一覧を取り・MCP の相手を起こし・
 * 先読みを始め・記憶を読み込む**。つまり画面が提案の一覧を出すためだけに、
 * エンジン一式が立ち上がっていた。
 *
 * 利用者は何も頼んでいない。**画面を開いただけ。**
 * MCP の相手が立ち上がらなければ 1 台につき最大 20 秒待たされ、
 * その間このやりとりを受ける入口が全部止まる。
 *
 * 中身はどれもファイルを読むだけで、モデルは要らない。だからここへ出す。
 * セッションを作るときは**同じものを渡す**（二つ持つと食い違う）。
 */
import { join } from 'node:path';
import { ProposalQueue } from '../agent/proposals.ts';
import { IdleScheduler } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../harness/idle-modes.ts';
import { DutyRoster } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import { stateDir } from './home.ts';
import { loadJournal, saveMerged } from './journal-file.ts';
import type { AasConfig } from '../config.ts';

export interface Journals {
  proposals: ProposalQueue;
  idle: IdleScheduler;
  duties: DutyRoster;
}

/**
 * 読み込む。**無いのは正常**なので、黙って空で始める。書くのは `saveJournals`。
 *
 * 一度読んだら使い回す。画面は 5 秒ごとに見に来るので、そのたびに
 * ディスクを読み直さない。
 */
export async function loadJournals(config: AasConfig): Promise<Journals> {
  const initCfg = config.initiative ?? {};

  const proposals = new ProposalQueue(join(stateDir(), 'proposals.json'));
  await proposals.load();

  // 使う思考モードだけを配る。減らせば、その分だけ静かになる。
  const idle = new IdleScheduler(
    BUILTIN_IDLE_MODES.filter((m) => !initCfg.modes || initCfg.modes.includes(m.id)),
    {
      perHour: initCfg.budgetPerHour ?? 12,
      minGapMs: (initCfg.minGapMinutes ?? 10) * 60_000,
      maxPerChange: initCfg.maxPerChange ?? 2,
      ...(initCfg.maxOpen !== undefined ? { maxOpen: initCfg.maxOpen } : {}),
    },
  );
  // 無いのは正常。在るのに読めないときは空で始め、保存の前に読み直す（`journal-file.ts`）。
  await loadJournal(idle, join(stateDir(), 'idle.json'), (v) => idle.restore(v as never));

  const duties = new DutyRoster(BUILTIN_DUTIES);
  await loadJournal(duties, join(stateDir(), 'duties.json'), (v) => duties.restore(v as never));

  return { proposals, idle, duties };
}

/**
 * 暇の実績と当番の記録を書く。起動のときに読めなかったものは、読み直せるまで書かない
 * （空で始めた分で、それまでの記録を上書きしない）。画面と端末が別々に持つので、書く前に読み直して、
 * ほかが書いた分を足してから書く（`saveMerged`）。
 */
export async function saveJournals(j: Pick<Journals, 'idle' | 'duties'>): Promise<string[]> {
  const { idle, duties } = j;
  const unsaved: string[] = [];
  const idlePath = join(stateDir(), 'idle.json');
  if (!await saveMerged(idle, idlePath, () => JSON.stringify(idle.records(), null, 2), (v, seen) => idle.rebase(v, seen))) unsaved.push(idlePath);
  const dutiesPath = join(stateDir(), 'duties.json');
  if (!await saveMerged(duties, dutiesPath, () => JSON.stringify(duties.records(), null, 2), (v, seen) => duties.rebase(v, seen))) unsaved.push(dutiesPath);
  return unsaved; // 書けなかったもの。黙って止め続けないよう、呼んだ側が言う
}
