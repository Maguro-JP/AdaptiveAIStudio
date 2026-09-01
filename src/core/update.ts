/**
 * 更新 — 新しくなっているかを見て、取ってくる。
 *
 * 「アプリなら更新ボタンがあるはず」に応えるための最小の仕掛け。
 * インストーラを作るのは運用フェーズだが、
 * **新しくなる手段だけは、それより先に要る**。
 * 手で git を打てる人しか新しくできない道具は、道具として半端になる。
 *
 * 危ないことはしない。ここでやるのは3つだけ。
 *
 *   1. 取ってくる前に、失うものが無いかを確かめる
 *   2. 早送りできる場合だけ進める（歴史を書き換えない）
 *   3. 進めたら、立ち上げ直してくださいと言う
 *
 * **自分自身を更新する**ので、取ってきた瞬間に
 * 動いているコードと置いてあるコードがズレる。
 * ズレたまま動き続ける方が危ないので、ここでは再起動しない。
 * 落として立ち上げ直すのは、外側（start.cmd / start.sh）の仕事。
 */
import { runGit, inspectGit } from '../agent/git.ts';
import { isPortable, productRoot } from './home.ts';

export interface UpdateStatus {
  /** 取ってこられる状態か */
  can: boolean;
  /** 新しく入る変更の数。0 なら最新 */
  behind: number;
  /** こちらにしか無い変更の数。あるなら早送りできない */
  ahead: number;
  branch?: string;
  /** 取ってこられないなら、その理由 */
  reason?: string;
  /** 新しく入る変更の見出し（新しい順） */
  incoming: string[];
}

export interface UpdateResult {
  ok: boolean;
  /** 進めた場合、いくつ進んだか */
  applied: number;
  message: string;
  /** 立ち上げ直しが要るか。進めたなら必ず要る。 */
  restartNeeded: boolean;
}

/** 配布物の置き場。portable は常にここにある（docs/DECISIONS.md）。 */
export const RELEASES_URL = 'https://github.com/Maguro-JP/AdaptiveAIStudio/releases/tag/portable';

/**
 * git の無い場所での、新しくする道。
 *
 * 会社の PC には git が無い。「git 管理下ではありません」で終わると、
 * そこで止まる。ブラウザなら届くので、取ってくる先と入れ替え方を言う。
 * **data/ は残す。**設定と記録はそこにあり、app/ を入れ替えても消えない作り。
 */
export function byHandUpdate(root: string): string {
  return [
    `新しい配布物をブラウザで取ってきて、app\\ だけ入れ替えてください: ${RELEASES_URL}`,
    'data\\（設定・記録・モデル）はそのまま残します。',
    `いまの版は VERSION に書いてあります（${productRoot(root)}）。`,
  ].join('\n');
}

/** いま新しくなれるか。取ってくる前に、必ずこれを通す。 */
export async function checkUpdate(root: string): Promise<UpdateStatus> {
  const state = await inspectGit(root);
  if (state.kind === 'notRepo' || state.kind === 'unavailable') {
    const why = state.kind === 'notRepo' ? 'git 管理下ではありません' : `git を確認できません（${state.reason}）`;
    // 配布物なら、git が無いのは当たり前。手で新しくする道を出す。
    const reason = isPortable(root)
      ? `${why}。\n${byHandUpdate(root)}`
      : `${why}。更新は git clone した場所でのみできます`;
    return { can: false, behind: 0, ahead: 0, incoming: [], reason };
  }
  if (state.kind === 'dirty') {
    // 未コミットの変更を巻き込むわけにはいかない。
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `未コミットの変更が ${state.changed.length} 件あります。先に片づけてください（失われる可能性があります）`,
    };
  }

  const fetched = await runGit(['fetch', '--quiet'], root);
  if (fetched.code !== 0) {
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `取りに行けませんでした（${firstLine(fetched.out)}）`,
    };
  }

  const upstream = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], root);
  if (upstream.code !== 0) {
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `${state.branch} に対応する向こう側がありません`,
    };
  }

  const counts = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root);
  const [aheadText = '0', behindText = '0'] = counts.out.trim().split(/\s+/);
  const ahead = Number(aheadText) || 0;
  const behind = Number(behindText) || 0;

  const log = behind > 0
    ? await runGit(['log', '--oneline', '--no-decorate', '-10', 'HEAD..@{upstream}'], root)
    : { code: 0, out: '' };
  const incoming = log.out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  if (ahead > 0) {
    return {
      can: false, behind, ahead, branch: state.branch, incoming,
      reason: `こちらにしか無い変更が ${ahead} 件あります。早送りできないので、手で取り込んでください`,
    };
  }

  return {
    can: behind > 0, behind, ahead, branch: state.branch, incoming,
    reason: behind === 0 ? '最新です' : undefined,
  };
}

/** 取ってくる。早送りできる場合だけ進める。 */
export async function applyUpdate(root: string): Promise<UpdateResult> {
  const status = await checkUpdate(root);
  if (!status.can) {
    return {
      ok: false, applied: 0, restartNeeded: false,
      message: status.reason ?? '更新できません',
    };
  }

  // --ff-only。混ぜたり書き換えたりはしない。
  // 更新ボタンが歴史を作り始めたら、直せる人がいなくなる。
  const pulled = await runGit(['merge', '--ff-only', '@{upstream}'], root);
  if (pulled.code !== 0) {
    return {
      ok: false, applied: 0, restartNeeded: false,
      message: `早送りできませんでした（${firstLine(pulled.out)}）`,
    };
  }

  return {
    ok: true,
    applied: status.behind,
    restartNeeded: true,
    message: `${status.behind}件の変更を取り込みました。反映するには立ち上げ直してください。`,
  };
}

/** 人に見せる形。何が入るのかを見てから押せるように。 */
export function describeUpdate(status: UpdateStatus): string {
  if (!status.can) return status.reason ?? '更新できません';
  const lines = [`${status.behind}件の変更があります（${status.branch}）`, ''];
  for (const c of status.incoming) lines.push(`  ${c}`);
  if (status.behind > status.incoming.length) {
    lines.push(`  … 他 ${status.behind - status.incoming.length} 件`);
  }
  return lines.join('\n');
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
