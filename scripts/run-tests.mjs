/**
 * 試験の走らせ役。
 *
 * `node --test test/*.test.ts` を npm から直に呼ぶと、環境によって壊れる。
 *   ・Windows の cmd.exe は `*` を展開しない。展開の可否が Node の版と殻に依存する
 *   ・型を剥がす指定は、版によって要ったり要らなかったりする
 * どちらも「こちらの作りは正しいのに走らない」形で出るので、
 * 走らせ方の差はここに閉じ込め、npm からは常に同じ呼び方にする。
 *
 * 使い方:
 *   node scripts/run-tests.mjs            すべて
 *   node scripts/run-tests.mjs gguf env   名前に含むものだけ
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
  .sort()
  // 殻に頼らず、こちらで並べて渡す。
  .map((f) => join('test', f));

if (files.length === 0) {
  console.error(filters.length ? `該当する試験がありません: ${filters.join(', ')}` : '試験が1つもありません');
  process.exit(1);
}

/**
 * 型を剥がす指定が要るかどうか。
 * v22.18 / v23.6 以降は既定で剥がれるので、付けると警告になる版がある。
 */
function needsStripFlag(version) {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major >= 24) return false;
  if (major === 23) return minor < 6;
  if (major === 22) return minor < 18;
  return true;
}

const args = [
  '--no-warnings',
  ...(needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : []),
  // 画面の JS を「まとまり」として読めるか確かめるのに要る。
  // node --check ではモジュール固有の誤りを見落とす。
  '--experimental-vm-modules',
  '--test',
  ...files,
];

/**
 * 試験が、作業コピーの設定を書き換えていないか。
 *
 * AAS_CONFIG を立て忘れた試験は、走らせた場所の `aas.config.json`、
 * つまり**開発中の設定そのもの**に書き込む。実際に起き、画面が使ってもいない
 * モデル名を出し続けた。落ちないので、出力を見ていても気づけない。
 */
const watched = join(root, 'aas.config.json');
const before = existsSync(watched) ? readFileSync(watched, 'utf8') : null;

/*
 * 落ちた試験の名前を、最後にまとめて出す。
 *
 * **一度だけ落ちて、名前が分からなかった。**出力は数百行あり、流し見では
 * `not ok` を拾えない。揺れているものは滅多に落ちないので、落ちた回の記録が
 * 取れないと、次に落ちるまで何も分からない。
 *
 * 出力はそのまま流す（見ている人の見え方は変えない）。拾うだけ足す。
 */
const failed = [];
const outer = [];
let rest = '';
const collect = (chunk) => {
  const text = rest + chunk.toString('utf8');
  const lines = text.split('\n');
  rest = lines.pop() ?? '';
  for (const line of lines) {
    const hit = /^(\s*)not ok \d+ - (.+)$/.exec(line);
    if (!hit) continue;
    // **束ね（suite）と中の試験を、二重に数えない。**
    // 束ねは字下げが浅い側に出る（`not ok 40 - 一覧に上限を置く`）。
    // 「1 subtest failed」は次の行にあるので、行だけ見ても分からない。
    // 字下げのある方（中の試験）だけを拾い、一つも無ければ浅い方を拾う。
    (hit[1].length > 0 ? failed : outer).push(hit[2].trim());
  }
};

const child = spawn(process.execPath, args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] });
child.stdout.on('data', (c) => { process.stdout.write(c); collect(c); });
child.on('error', (e) => { console.error(e.message); process.exit(1); });
child.on('close', (code, signal) => {
  const names = failed.length > 0 ? failed : outer;
  if (names.length > 0) {
    console.error(`\n落ちた試験 ${names.length} 件:`);
    for (const name of names) console.error(`  - ${name}`);
  }
  const after = existsSync(watched) ? readFileSync(watched, 'utf8') : null;
  if (after !== before) {
    console.error('\n試験が作業コピーの設定を書き換えました: aas.config.json');
    console.error(before === null
      ? '  無かったものが作られています。'
      : '  中身が変わっています。');
    console.error('  設定を書く試験は、先に AAS_CONFIG を仮の場所へ逃がしてください。');
    process.exit(1);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
