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
import { readFile } from 'node:fs/promises';
import { ProposalQueue } from '../agent/proposals.ts';
import { IdleScheduler, type ModeStat } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../harness/idle-modes.ts';
import { DutyRoster, type DutyRecord } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import { stateDir } from './home.ts';
import type { AasConfig } from '../config.ts';

export interface Journals {
  proposals: ProposalQueue;
  idle: IdleScheduler;
  duties: DutyRoster;
}

/**
 * 読み込む。**無いのは正常**なので、黙って空で始める。
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
    },
  );
  try {
    idle.restore(JSON.parse(await readFile(join(stateDir(), 'idle.json'), 'utf8')) as ModeStat[]);
  } catch { /* 記録が無いのは正常 */ }

  const duties = new DutyRoster(BUILTIN_DUTIES);
  try {
    duties.restore(JSON.parse(await readFile(join(stateDir(), 'duties.json'), 'utf8')) as DutyRecord[]);
  } catch { /* 記録が無いのは正常 */ }

  return { proposals, idle, duties };
}
