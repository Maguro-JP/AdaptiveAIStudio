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
import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isMain } from './is-main.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

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


/**
 * 落ちた試験の名前を拾う。
 *
 * **一度だけ落ちて、名前が分からなかった。**出力は数千行あり、流し見では
 * `not ok` を拾えない。揺れているものは滅多に落ちないので、落ちた回の記録が
 * 取れないと、次に落ちるまで何も分からない。
 *
 * **診断の塊（`---` から `...`）の中は読まない。**落ちた理由の中に、子として
 * 走らせた試験の出力がそのまま入ることがある（`test/installed-env.test.ts` は
 * 子の TAP を assert の言葉に入れる）。その中の `not ok` を拾うと、**落ちて
 * いない試験の名前を報告する。**名前を頼りに探しに行くので、そこで丸ごと
 * 時間を失う。
 */
export function failedNames(text) {
  const inner = [];
  const outer = [];
  let block;
  for (const line of text.split('\n')) {
    if (block !== undefined) {
      // 開いたときと同じ字下げの `...` で閉じる。
      if (line === `${block}...`) block = undefined;
      continue;
    }
    const opens = /^(\s*)---\s*$/.exec(line);
    if (opens) { block = opens[1]; continue; }
    const hit = /^(\s*)not ok \d+ - (.+)$/.exec(line);
    if (!hit) continue;
    // **suite と中の試験を、二重に数えない。**
    // suite は字下げが浅い側に出る（`not ok 40 - 一覧に上限を置く`）。
    // 「1 subtest failed」は次の行にあるので、行だけ見ても分からない。
    // 字下げのある方（中の試験）だけを拾い、一つも無ければ浅い方を拾う。
    (hit[1].length > 0 ? inner : outer).push(hit[2].trim());
  }
  return inner.length > 0 ? inner : outer;
}

/** 走らせる。落ちたら、そのまま終わりの符号にする。 */
function main() {
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
   * **走らせる側の env で、結果を変えない。**
   *
   * `AAS_HOME` や `AAS_CONFIG` が外から立っていると、仮のフォルダを作って
   * 確かめるテストが**そちらを見に行く**。使う人の機械ではインストーラの入口が
   * env を立てるので、`selftest` から回したときだけ「壊れていないのに NG」が出た
   * （実測: 設定・doctor・実走で 5 件）。**NG を信じてもらえなくなるのが、
   * いちばん高くつく。**
   *
   * テストが見たいのはコードなので、ここで消す。入れた機械の env でも通ることは、
   * `test/installed-env.test.ts` が**わざと立てて**確かめる（一箇所に寄せる）。
   */
  const AAS_ENV = [
    'AAS_HOME', 'AAS_CONFIG', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR',
    'AAS_REPORT_DIR', 'AAS_UI_PORT',
  ];
  const env = { ...process.env };
  for (const key of AAS_ENV) delete env[key];

  /*
   * 試験の一時フォルダを、回ごとの場所に寄せる。
   *
   * 試験は後片付けを after で行うので、途中で止める（時間切れ・Ctrl-C）と残る。
   * /tmp の直下に数百個残り、ディスクが埋まって次の回の pre-push が ENOSPC で落ちた。
   * 回ごとのフォルダにまとめ、終わりに消す。前に止めた回の分は、その回のプロセスが
   * もう居なければ、ここで消す（動いている別の回の分には触らない）。
   */
  const scratchRoot = join(tmpdir(), 'aas-tests');
  sweepStale(scratchRoot);
  const scratch = join(scratchRoot, `run-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  env.TMPDIR = scratch; env.TMP = scratch; env.TEMP = scratch;
  /*
   * 家（HOME）も回ごとの場所へ向ける。AAS_HOME を立て忘れた試験は `~/.aas` へ書く
   * （記憶が `~/.aas/memory.jsonl` に溜まり、root が試験の一時フォルダの行が並んでいた）。
   * 使う人の家に試験の跡を残さない。git の設定だけは元の家のものを読ませる。
   */
  const realHome = homedir();
  const fakeHome = join(scratch, 'home');
  mkdirSync(fakeHome, { recursive: true });
  env.HOME = fakeHome; env.USERPROFILE = fakeHome;
  if (!env.GIT_CONFIG_GLOBAL && existsSync(join(realHome, '.gitconfig'))) env.GIT_CONFIG_GLOBAL = join(realHome, '.gitconfig');

  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });
  // 出力はそのまま流す（見ている人の見え方は変えない）。溜めておいて、終わりに読む。
  let said = '';
  child.stdout.on('data', (c) => { process.stdout.write(c); said += c.toString('utf8'); });
  child.on('error', (e) => { console.error(e.message); process.exit(1); });
  child.on('close', (code, signal) => {
    rmSync(scratch, { recursive: true, force: true });
    const names = failedNames(said);
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
}

/** 止めた回が残した `run-<pid>` を消す。その pid が生きている間は触らない。 */
export function sweepStale(dir, alive = pidAlive) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = /^run-(\d+)$/.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/*
 * 走らせるのは、直に呼ばれたときだけ。名前の拾い方は試験から読むので、
 * 読み込んだだけで走ってはいけない（読み込んだ側の argv で `--test` を
 * 立て直して、試験の中で試験が走る）。
 * argv[1] は Z:\...\run-tests.mjs（円記号・ドライブ文字）、
 * import.meta.url は file:///... なので、URL にそろえてから比べる。
 */
// 実体の道どうしで比べる（`is-main.mjs`）。リンク越しに起こすと、試験を一つも走らせずに 0 で終わっていた
if (isMain(import.meta.url)) main();
