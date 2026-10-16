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
import { isPortable, isDistributed, productRoot } from './home.ts';
import { currentVersion, describeVersion } from './version.ts';

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
  /** 見せた時点の向こう側のコミット。取り込むときはここまでにする（確かめている間に向こうが進んでも、見せていないものを入れない） */
  target?: string;
  /**
   * 調べられなかった（git 管理下でない・未コミットの変更・取りに行けない・向こう側が無い・数えられない）。
   * `behind: 0` は「最新」と「分からない」の両方に使っていたので、終了コードが 0 になり、呼んだ側が「最新」と受け取った。
   */
  failed?: true;
}

export interface UpdateResult {
  ok: boolean;
  /** 進めた場合、いくつ進んだか */
  applied: number;
  message: string;
  /** 立ち上げ直しが要るか。進めたなら必ず要る。 */
  restartNeeded: boolean;
}

/** bundle の置き場。portable は常にここにある（docs/DECISIONS.md）。 */
/**
 * 手で新しくするときの、取ってくる先。
 *
 * **`releases/tag/portable` を指していた。**このタグは、タグを付けずに手で
 * 組んだときにしか差し替わらない。タグを付けた回は、その版の方へ公開される。
 * つまり `portable` は放っておくほど古くなるタグで、実際に最新の版より
 * 5 日古かった（v0.3.0 が 09-06、portable は 09-01）。
 *
 * 手で入れ替える人は、いちばん新しいものが要る。GitHub が最新へ回してくれる
 * `releases/latest` を指す。
 */
export const RELEASES_URL = 'https://github.com/Maguro-JP/AdaptiveAIStudio/releases/latest';

/**
 * git の無い場所での、新しくする道。
 *
 * git の無い環境もある。「git 管理下ではありません」で終わると、
 * そこで止まる。ブラウザなら届くので、取ってくる先と入れ替え方を言う。
 *
 * **その場で `app\` を上書きさせない。**上書きすると、新しい方が動かなかった
 * ときに戻る先が無い。別のリポジトリ が同じところで「新しい ZIP は別のフォルダへ
 * 展開する。古いフォルダは消さずに残す。問題がないことを確かめてから消す」と
 * 書いていて、そちらが正しい。
 *
 * ただし置き場の作りが違う。向こうはデータが ホームの下の隠しフォルダ（アプリの外）に
 * あるので、どちらのフォルダから起動しても同じものが見える。**こちらは
 * `data\` がフォルダの中**なので、そのまま真似ると新しい方が空で立ち上がる。
 * だから `data\` を移す一手を挟む。
 *
 * 版も一緒に出す。控えていないと「入れ替えたつもりで古いまま動いていた」に
 * 気づけない（ここで実際にやった）。
 */
/** インストーラで入れた形の、新しくする道。git clone の案内は、入れた形の利用者には打てない。 */
export function byInstallerUpdate(version?: string): string {
  return [
    '新しい版のインストーラ（setup.exe）を取ってきて、実行してください。',
    `  取ってくる: ${RELEASES_URL}`,
    ...(version ? ['', `いまの版: ${version}`] : []),
  ].join('\n');
}

export function byHandUpdate(root: string, version?: string): string {
  return [
    '新しいbundle をブラウザで取ってきて、入れ替えてください。',
    `  1. 取ってくる: ${RELEASES_URL}`,
    '  2. いまとは別のフォルダに展開する。いまのフォルダは消さない',
    '     （新しい方で困ったら、古い方を押せば戻せます）',
    `  3. いまの data\\（設定・記録・モデル）を、新しいフォルダへ移す`,
    '     — モデルは大きいので、コピーではなく移す方が速いです',
    '  4. 新しいフォルダの AdaptiveAIStudio.cmd を押す',
    '  5. 版が変わったことを確かめてから、古いフォルダを消す',
    '',
    version
      ? `いまの版: ${version}  ← 控えてください。控えないと「入れ替えたつもりで古いまま」に気づけません`
      : `いまの版は VERSION に書いてあります（${productRoot(root)}）。`,
    '戻すときは、data\\ を古いフォルダへ移し直して、そちらを押してください。',
  ].join('\n');
}

/** いま新しくなれるか。取ってくる前に、必ずこれを通す。 */
export async function checkUpdate(root: string): Promise<UpdateStatus> {
  /*
   * 配った形（portable・インストーラ）は git で新しくするものではない。git を見ない。見ると、置かれた場所の上にある
   * 別のリポジトリ（portable を自分のプロジェクトの中に置いた等）を製品と取り違え、その上流を「製品の更新」として出していた。
   */
  if (isDistributed(root)) {
    const reason = isPortable(root)
      ? byHandUpdate(root, describeVersion(await currentVersion()))
      : byInstallerUpdate(describeVersion(await currentVersion()));
    return { can: false, behind: 0, ahead: 0, incoming: [], reason };
  }
  const state = await inspectGit(root);
  if (state.kind === 'notRepo' || state.kind === 'unavailable') {
    const why = state.kind === 'notRepo' ? 'git 管理下ではありません' : `git を確認できません（${state.reason}）`;
    // bundleなら、git が無いのは当たり前。手で新しくする道を出す。
    const reason = isPortable(root)
      ? `${why}。\n${byHandUpdate(root, describeVersion(await currentVersion()))}`
      : `${why}。更新は git clone した場所でのみできます`;
    return { can: false, behind: 0, ahead: 0, incoming: [], reason, ...(isPortable(root) ? {} : { failed: true as const }) };
  }
  if (state.kind === 'dirty') {
    // 未コミットの変更を巻き込むわけにはいかない。
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `未コミットの変更が ${state.changed.length} 件あります。先に片づけてください（失われる可能性があります）`, failed: true,
    };
  }

  const fetched = await runGit(['fetch', '--quiet'], root);
  if (fetched.code !== 0) {
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `取りに行けませんでした（${firstLine(fetched.out)}）`, failed: true,
    };
  }

  const upstream = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], root);
  if (upstream.code !== 0) {
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [],
      reason: `${state.branch} に対応する向こう側がありません`, failed: true,
    };
  }

  const counts = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root);
  const [aheadText = '', behindText = ''] = counts.stdout.trim().split(/\s+/);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  // 数えられなかったのを 0/0（最新）と読まない
  if (counts.code !== 0 || !Number.isInteger(ahead) || !Number.isInteger(behind) || aheadText === '' || behindText === '') {
    return {
      can: false, behind: 0, ahead: 0, branch: state.branch, incoming: [], failed: true,
      reason: `向こう側との差を数えられませんでした（${firstLine(counts.out)}）`,
    };
  }

  const log = behind > 0
    ? await runGit(['log', '--oneline', '--no-decorate', '-10', 'HEAD..@{upstream}'], root)
    : { code: 0, out: '', stdout: '' };
  // 入ってくる変更は標準出力だけから数える（警告の行を変更として並べない）
  const incoming = log.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // 手元にだけ変更があっても、取り込むものが無ければ最新（手で取り込めとは言わない）
  if (ahead > 0 && behind > 0) {
    return {
      can: false, behind, ahead, branch: state.branch, incoming,
      reason: `こちらにしか無い変更が ${ahead} 件あります。早送りできないので、手で取り込んでください`,
    };
  }

  const target = (await runGit(['rev-parse', '@{upstream}'], root)).stdout.trim() || undefined;
  return {
    can: behind > 0, behind, ahead, branch: state.branch, incoming,
    reason: behind === 0 ? '最新です' : undefined,
    ...(target ? { target } : {}),
  };
}

/** 取ってくる。早送りできる場合だけ進める。 */
export async function applyUpdate(root: string, seen?: UpdateStatus): Promise<UpdateResult> {
  // 確かめ（未コミットの変更・早送りできるか）はやり直す。取り込む先は、見せた時点の版に留める
  // （向こう側をそのまま取り込むと、確かめている間に入った見ていない変更まで入れ、件数も見せた数と食い違った）
  const now = await checkUpdate(root);
  const status = now.can && seen?.target ? { ...now, target: seen.target, behind: seen.behind } : now;
  if (!status.can) {
    return {
      ok: false, applied: 0, restartNeeded: false,
      message: status.reason ?? '更新できません',
    };
  }

  // --ff-only。混ぜたり書き換えたりはしない。
  // 更新ボタンが歴史を作り始めたら、直せる人がいなくなる。
  const pulled = await runGit(['merge', '--ff-only', status.target ?? '@{upstream}'], root);
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
