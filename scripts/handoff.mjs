/**
 * ローカルとクラウドの間で、作業中のものを渡す。
 *
 * クラウドで開発すると Linux の容れ物、ローカルで開発すると Windows。
 * **同時には触れないし、片方の作業はもう片方から見えない。**
 * 渡す道が無いので、同じ作業を二度やることになる。
 *
 * git はもともとこれをやるための物なので、**ローカルをブランチとして扱う**。
 * 機械ごとに `wip/<名前>` を持ち、送る・取る、の二つだけにする。
 *
 *   npm run handoff              いまの作業を、この機械のブランチへ送る
 *   npm run handoff -- --take    渡されているものを、いまのブランチへ取り込む
 *   npm run handoff -- --list    何が渡されているかを見る
 *
 * 決め方（ブランチの名前・どれを取り込むか・止める条件）は `handoff-plan.mjs`。
 * **走らせないと出ない判断は、検査にかけられない**ので分けてある。
 *
 * wip/ のブランチでは CI は回らない（PR・週1・手動だけ）。push の手前の検査も、
 * wip/ だけは通す（`.githooks/pre-push`）。**作業中のものを渡すのに
 * 4分かけると、渡すこと自体をやめる。**
 */
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { branchFor, pickToTake, whyNotSend, whyNotTake, jst } from './handoff-plan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitLoud = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });

const mine = branchFor({ platform: process.platform, hostname: hostname(), env: process.env });
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** 渡されているものを、全部見る。 */
function waiting() {
  git('fetch', '--prune', 'origin', '+refs/heads/wip/*:refs/remotes/origin/wip/*');
  const raw = git(
    'for-each-ref', '--format=%(refname:lstrip=3)%09%(committerdate:iso-strict)%09%(subject)',
    'refs/remotes/origin/wip',
  );
  return raw.split('\n').filter(Boolean).map((line) => {
    // lstrip=3 で `refs/remotes/origin/` が落ちる。**`wip/` はもう付いている。**
    // 足していたので `wip/wip/cloud` になり、取り込みがその名前で落ちた
    // （本物のリポジトリで回して出た。単体の検査では出ない）。
    const [name, at, subject] = line.split('\t');
    return { name, at, subject };
  });
}

const dirty = git('status', '--porcelain').length > 0;
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

if (has('--list')) {
  const all = waiting();
  console.log(`この機械のブランチ: ${mine}\n`);
  if (all.length === 0) { console.log('渡されているものはありません。'); process.exit(0); }
  for (const b of all) {
    const me = b.name === mine ? ' ←この機械' : '';
    console.log(`  ${b.name}${me}`);
    console.log(`      ${jst(b.at)}  ${b.subject}`);
  }
  process.exit(0);
}

if (has('--take')) {
  const stop = whyNotTake({ dirty });
  if (stop) { console.error(stop); process.exit(1); }

  const all = waiting();
  const picked = pickToTake({ branches: all, mine, want: valueOf('--take') });
  if (!picked.ok) {
    console.error(picked.why);
    if (picked.choices.length > 0) {
      console.error('\n渡されているもの:');
      for (const c of picked.choices) console.error(`  ${c}`);
      console.error('\n  npm run handoff -- --take <名前>');
    }
    process.exit(1);
  }

  console.log(`${picked.take} を ${branch} へ取り込みます。`);
  try {
    // **相手の履歴を書き換えない。**merge で入れる（rebase すると、向こうの
    // 機械の checkout が壊れる）。
    gitLoud('merge', '--no-edit', `origin/${picked.take}`);
  } catch {
    /*
     * **Node のスタックを見せない。**
     *
     * ぶつかるのは普通のことで、壊れたわけではない。ここで
     * `Error: Command failed: git merge …` と何十行も出していた。
     * 読む人には何が起きたのか分からず、次に何をすればいいかも分からない。
     */
    console.error('');
    console.error('ぶつかりました。両方で同じ所を触っています。');
    console.error('  git status          どのファイルか見る');
    console.error('  （直してから）git add -A && git commit');
    console.error('  git merge --abort   やめて元へ戻す');
    process.exit(1);
  }
  console.log('');
  console.log('取り込みました。**ここからは確かめていないものです。**');
  console.log('  npm run check   通してから main へ');
  process.exit(0);
}

/* ---------- 送る ---------- */
/*
 * まだ押していないコミットの数。
 *
 * **`origin/<ブランチ>` が無い形で落ちていた。**クローンした直後や、まだ一度も
 * 押していないブランチでは、その名前が存在しない。本物のリポジトリで回して出た
 * （単体の検査では出ない。git を叩いていないので）。
 *
 * 向こうにブランチが無いなら、こちらのコミットは全部まだ渡っていない。
 */
const upstream = `origin/${branch}`;
let ahead;
try {
  git('rev-parse', '--verify', '--quiet', upstream);
  ahead = Number(git('rev-list', '--count', `${upstream}..HEAD`).trim() || '0');
} catch {
  ahead = Number(git('rev-list', '--count', 'HEAD').trim() || '0');
}
const stop = whyNotSend({ branch, dirty, ahead });
if (stop) { console.log(stop); process.exit(0); }

if (dirty) {
  gitLoud('add', '-A');
  const when = jst(new Date().toISOString());
  // **確かめていないことを、コミットの文にも書く。**取り込む側が見る。
  gitLoud('commit', '-m',
    `作業中（${mine} / ${when}）\n\n`
    + '渡すために作ったコミットです。確かめていません。\n'
    + '取り込んだ側で npm run check を通してください。');
}

console.log(`${mine} へ送ります。`);
// 自分の作業を置くだけのブランチなので、上書きしてよい。ただし
// **知らない間に進んでいたら止める**（--force-with-lease）。
gitLoud('push', '--force-with-lease', 'origin', `HEAD:refs/heads/${mine}`);
console.log('');
console.log('送りました。もう片方では:');
console.log('  npm run handoff -- --take');
