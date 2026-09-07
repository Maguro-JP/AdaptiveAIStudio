/**
 * ローカルとクラウドの間で、作業中のものを渡す。**その決め方だけ。**
 *
 * git を叩くところ（`handoff.mjs`）とは分けてある。**走らせないと出ない
 * 判断は、検査にかけられない。**ブランチの名前の付け方も、どれを取り込むかも、
 * ここで決めて、ここで確かめる。
 *
 * ## なぜ要るか
 *
 * クラウドで開発すると Linux の容れ物、ローカルで開発すると Windows。
 * **同時には触れないし、片方の作業はもう片方から見えない。**
 * 渡す道が無いので、同じ作業を二度やることになる。
 *
 * git はもともとこれをやるための物なので、**ローカルをブランチとして扱う**。
 * 機械ごとに `wip/<名前>` を持ち、送る・取る、の二つだけにする。
 */

/**
 * この機械のブランチの名前。
 *
 * git のブランチに使えない字を落とす。名前が決まらないと渡す先が決まらないので、
 * **必ず何かを返す。**
 *
 * @param {{ platform: string; hostname: string; env?: Record<string, string | undefined> }} how
 */
export function branchFor(how) {
  const named = how.env?.['AAS_HANDOFF_NAME'];
  const raw = named && named.trim().length > 0
    ? named
    : `${how.platform}-${how.hostname}`;
  const safe = raw
    .toLowerCase()
    // git のブランチに使えない字と、紛らわしい字を `-` にする。
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `wip/${safe || 'unnamed'}`;
}

/**
 * 取り込む相手を決める。
 *
 * **自分のブランチは取り込まない。**一つしか無ければそれ。複数あるなら決めない
 * （こちらで選ぶと、意図しない方を取り込んで作業が消える）。
 *
 * @param {{ branches: Array<{ name: string; at: string }>; mine: string; want?: string }} how
 * @returns {{ ok: true; take: string } | { ok: false; why: string; choices: string[] }}
 */
export function pickToTake(how) {
  const others = how.branches.filter((b) => b.name !== how.mine);
  const choices = others.map((b) => b.name);

  if (how.want) {
    const named = others.find((b) => b.name === how.want || b.name === `wip/${how.want}`);
    if (named) return { ok: true, take: named.name };
    return {
      ok: false,
      why: others.some((b) => b.name === how.mine)
        ? `${how.want} は自分のブランチです`
        : `${how.want} が見つかりません`,
      choices,
    };
  }

  if (others.length === 0) {
    return { ok: false, why: '渡されているものがありません', choices: [] };
  }
  if (others.length === 1) return { ok: true, take: others[0].name };
  return { ok: false, why: 'どれを取り込むか決まりません', choices };
}

/**
 * 送る前に、止めるべきか。
 *
 * **main を wip の代わりにしない。**送るのは作業中のもので、確かめていない。
 * 取り違えると、確かめていないものが main に載る。
 *
 * @param {{ branch: string; dirty: boolean; ahead: number }} state
 */
export function whyNotSend(state) {
  if (!state.branch.startsWith('wip/') && state.branch !== 'main') {
    // main 以外のブランチで作業しているのは普通。止めない。
  }
  if (!state.dirty && state.ahead === 0) return '渡すものがありません（変更も、未 push のコミットも無し）';
  return undefined;
}

/**
 * 取る前に、止めるべきか。
 *
 * **書きかけの上に重ねない。**取り込むと衝突して、どちらが自分の書いたもの
 * か分からなくなる。先に片づけてもらう。
 *
 * @param {{ dirty: boolean }} state
 */
export function whyNotTake(state) {
  if (state.dirty) {
    return '書きかけのものがあります。先にコミットするか、片づけてください'
      + '（この上に取り込むと、どちらが自分の書いたものか分からなくなります）';
  }
  return undefined;
}

/** JST で見せる。機械の側が UTC なのは構わないが、人に見せるときは直す。 */
export function jst(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const j = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`
    + ` ${p(j.getUTCHours())}:${p(j.getUTCMinutes())} JST`;
}
