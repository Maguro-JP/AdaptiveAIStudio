/**
 * 履歴の全部（すべての参照から辿れる blob）を、外へ出るときの検問（`inspectOutbound`）に掛ける（docs/PUBLISHING.md の 9）。
 *
 *   node scripts/scan-history.mjs [--repo <リポジトリの場所>]
 *
 * 今のファイルだけでなく、消したファイルや古い版の中身も見る。当たったものを種類ごとに数え、
 * どのファイルで当たったかと、伏せた抜き出しを並べる。試験の作り物も当たるので、本物かどうかは人が見て決める。
 * 何も書き換えない。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inspectOutbound } from '../src/harness/gate.ts';

const at = process.argv.indexOf('--repo');
const repo = resolve(at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : process.cwd());
const git = (args, input) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 1 << 30 });

// blob ごとに、最初に見つけた道を一つ持つ（同じ中身は一度だけ見る）
const pathOf = new Map();
for (const line of git(['rev-list', '--objects', '--all']).toString('utf8').split('\n')) {
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const sha = line.slice(0, sp);
  if (!pathOf.has(sha)) pathOf.set(sha, line.slice(sp + 1));
}
const shas = [...pathOf.keys()];
const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], shas.join('\n') + '\n').toString('utf8');
const blobs = types.split('\n').filter((l) => l.endsWith(' blob')).map((l) => l.split(' ')[0]);

const out = git(['cat-file', '--batch'], blobs.join('\n') + '\n');
const hits = new Map();
let pos = 0;
for (const sha of blobs) {
  const nl = out.indexOf(0x0a, pos);
  const size = Number(out.subarray(pos, nl).toString('latin1').split(' ')[2]);
  const body = out.subarray(nl + 1, nl + 1 + size);
  pos = nl + 1 + size + 1;
  if (body.includes(0)) continue; // 中身が文字でないもの（画像など）は見ない
  for (const f of inspectOutbound(body.toString('utf8')).findings) {
    if (!hits.has(f.kind)) hits.set(f.kind, []);
    hits.get(f.kind).push({ path: pathOf.get(sha), excerpt: f.excerpt });
  }
}

console.log(`blob ${blobs.length} 件を見ました（${repo}）`);
if (hits.size === 0) console.log('当たったものはありません');
for (const [kind, list] of hits) {
  console.log(`== ${kind}: ${list.length} 件`);
  for (const h of list) console.log(`  ${h.path}  ${h.excerpt.replace(/\s+/g, ' ').slice(0, 100)}`);
}
console.log('本物かどうかは、上の一覧を見て決めてください（試験の作り物と書き方の例も当たります）。');
