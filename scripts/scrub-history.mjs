/**
 * 過去の履歴から、本物のメールアドレスを消した複製を手元に作る（docs/PUBLISHING.md の 8）。
 *
 * 元のリポジトリと origin には触らない。指定したフォルダに新しく複製し、その中だけを書き換えて、
 * 消えたかを数える。押す（force push）のは、結果を見た人が自分で行う。
 *
 *   node scripts/scrub-history.mjs --address <消すアドレス> --noreply <作成者に残すアドレス> --out <空のフォルダ> [--also <消す文字列>]...
 *
 * - `--also` は、中身から消したいほかの文字列（Windows の利用者名を含む道など）。`user` に置き換える。何度でも渡せる
 *
 * - 中身とコミットメッセージの中のアドレスは `user@example.com` に置き換える
 * - 作成者・コミッターの欄は、名前を残し、アドレスだけ `--noreply` に置き換える
 * - 消すアドレスはリポジトリに書かない（引数で渡す）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value || value.startsWith('--')) {
    console.error(`--${name} がありません。使い方は先頭のコメントを見てください。`);
    process.exit(2);
  }
  return value;
}

const address = arg('address');
const noreply = arg('noreply');
const out = resolve(arg('out'));
const DUMMY = 'user@example.com';
// 中身から消すほかの文字列（`--also` を何度でも）。アドレスと同じ形の検めをする
const given = process.argv.flatMap((a, i) => (a === '--also' ? [process.argv[i + 1]] : [])).filter(Boolean);
// 全角の綴り（`ｍ＠ｅｘａｍｐｌｅ` の形）も消す。Windows の利用者名は全角のことがあり、半角だけで探して「消えた」と言いながら残していた
const fullWidth = (t) => [...t].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x21 && c <= 0x7e ? String.fromCharCode(c + 0xfee0) : ch; }).join('');
const also = [...new Set([...given, ...[process.argv[process.argv.indexOf('--address') + 1], ...given].map(fullWidth)])]
  .filter((x) => x && x !== process.argv[process.argv.indexOf('--address') + 1]);
if (also.some((x) => !/^[^\s'"\\|]+$/.test(x))) {
  console.error('--also の文字列の形が読めません（空白・引用符・\\・| を含めない）。');
  process.exit(2);
}
if (!/^[^\s'"\\|]+@[^\s'"\\|]+$/.test(address) || !/^[^\s'"\\|]+@[^\s'"\\|]+$/.test(noreply)) {
  console.error('アドレスの形が読めません（空白・引用符・| を含めない）。');
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} が空ではありません。空のフォルダか、まだ無い場所を渡してください。`);
  process.exit(2);
}

const here = process.cwd();
const git = (args, cwd = out) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const origin = git(['remote', 'get-url', 'origin'], here).trim();

mkdirSync(out, { recursive: true });
console.log(`複製しています: ${origin}`);
git(['clone', '--quiet', '--no-local', origin, out], here);
// ブランチとタグを全部、手元のブランチにする（書き換えは手元の参照にだけ効く）
for (const ref of git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']).split('\n')) {
  const name = ref.replace(/^origin\//, '');
  if (!name || name === 'HEAD' || ref === 'origin') continue;
  try { git(['branch', '--quiet', '--force', name, ref]); } catch { /* 今のブランチ */ }
}

// sed に渡す形（. などをそのまま一文字として当てる）
const escapeSed = (t) => t.replace(/[.[\]*^$/+?(){}]/g, '\\$&');
const pattern = escapeSed(address);
// アドレスを先に置き換える（`--also` がアドレスの一部のとき、アドレスが崩れて残らないように）
const sedScript = [`s|${pattern}|${DUMMY}|g`, ...also.map((x) => `s|${escapeSed(x)}|user|g`)].join(';');
const filters = join(out, '.git', 'scrub');
mkdirSync(filters, { recursive: true });
writeFileSync(join(filters, 'index.sh'), [
  `git grep --cached -l -I -F ${['$SCRUB_ADDRESS', ...also].map((x, i) => (i === 0 ? '-e "$SCRUB_ADDRESS"' : `-e '${x}'`)).join(' ')} | while IFS= read -r f; do`,
  '  mode=$(git ls-files -s -- "$f" | cut -d" " -f1)',
  `  h=$(git show ":$f" | sed '${sedScript}' | git hash-object -w --stdin)`,
  '  git update-index --cacheinfo "$mode,$h,$f"',
  'done',
  '',
].join('\n'));

const env = {
  ...process.env,
  SCRUB_ADDRESS: address,
  FILTER_BRANCH_SQUELCH_WARNING: '1',
};
const envFilter = [
  `if [ "$GIT_AUTHOR_EMAIL" = "${address}" ]; then export GIT_AUTHOR_EMAIL="${noreply}"; fi`,
  `if [ "$GIT_COMMITTER_EMAIL" = "${address}" ]; then export GIT_COMMITTER_EMAIL="${noreply}"; fi`,
].join('\n');
console.log('書き換えています（コミットの数だけ時間がかかります）');
execFileSync('git', [
  'filter-branch', '--force',
  '--env-filter', envFilter,
  '--index-filter', `sh "${join(filters, 'index.sh')}"`,
  '--msg-filter', `sed '${sedScript}'`,
  '--tag-name-filter', 'cat',
  '--', '--branches', '--tags',
], { cwd: out, env, stdio: ['ignore', 'ignore', 'inherit'] });
// 書き換え前の記録（refs/original）と元の参照を外し、数えるときに混ぜない（origin/HEAD を残すと、指す先の無い参照になる）
try { git(['remote', 'set-head', 'origin', '--delete']); } catch { /* 無い */ }
for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/original', 'refs/remotes']).split('\n').filter(Boolean)) {
  git(['update-ref', '-d', ref]);
}

// 数える。中身・メッセージ・作成者の欄のどれにも残っていないこと
const commits = git(['rev-list', '--branches', '--tags']).split('\n').filter(Boolean);
let inContent = 0;
for (const c of commits) {
  try { git(['grep', '-q', '-I', '-F', '-e', address, ...also.flatMap((x) => ['-e', x]), c]); inContent += 1; } catch { /* 無い */ }
}
const inMeta = git(['log', '--branches', '--tags', '--format=%ae%n%ce%n%B']).split('\n').filter((l) => [address, ...also].some((x) => l.includes(x))).length;
console.log(`コミット ${commits.length} 件を見ました。中身に残った: ${inContent} 件、作成者の欄とメッセージに残った: ${inMeta} 行`);
if (inContent > 0 || inMeta > 0) {
  console.error('消し切れていません。押さないでください。');
  process.exit(1);
}
console.log([
  '',
  '消えました。押す前に、この複製で npm test と秘密の走査（docs/PUBLISHING.md の 9）を通してください。',
  '押すときは、この複製の中で（取り返しがつかないので、元の複製を消さずに残しておく）:',
  '  git push --force --all origin',
  '  git push --force --tags origin',
].join('\n'));
