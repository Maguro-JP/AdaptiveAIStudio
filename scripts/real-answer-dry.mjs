/**
 * CI へ出す前に、**CI が動かすものを、この機械で一度動かす。**
 *
 * `scripts/real-answer.mjs` は本物の重みが要るものだと思って、手元で一度も
 * 動かさずに CI へ出していた。**要るのは重みを落とすところだけで、残りは
 * 作り物の模型で通る。**その結果、落ちた回が積み上がった（9月の実績）:
 *
 *   09-16  本物の重みの回を 3 連続で落とした（50 分）
 *   09-19  正しい答えを落とす判定と、押し戻しで落とした（11 分）
 *   09-22  記録が空のまま Windows で落とした（17 分・課金は 2 倍）
 *
 * どれも、ここで 1 分もかからずに見えるものだった。
 *
 * 見るのは**配管**であって、答えの中身ではない。重みは乱数なので、
 * 中身の確かめは落ちるのが正しい。ここが見るのはこの 4 つ:
 *
 *   1. 終わる（止まらない）
 *   2. 自分で白黒を付けて終わる（終了コードが 0 か 1。落ちて 1 以外にならない）
 *   3. 読む側の声が記録に届く（backend の一行）
 *   4. 二つの確かめが両方とも走って、まとめの行まで出る
 *
 * **答えの中身とモデルの振る舞いは見ない。**見ると、走らせる機械で結果が
 * 変わる確かめになる（乱数の模型が吐くものは、CPU の backend が変われば変わる）。
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 止まっていないことを見るための上限。**速さの閾値ではない。** */
const HANG_MS = 600_000;

if (!existsSync(join(root, 'node_modules', 'node-llama-cpp'))) {
  console.log('  node-llama-cpp が入っていないので飛ばします（読む側を起こせません）');
  process.exit(0);
}

// 仮の作業場は、一つ上まで自分のものにする（temp の直下を見ない）。
const base = await mkdtemp(join(tmpdir(), 'aas-dry-'));
const dir = join(base, 'models');
await mkdir(dir, { recursive: true });
const gguf = join(dir, 'tiny.gguf');

try {
  // 種を固定した作り物。走らせるたびに変わるものを作らない。
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), gguf], { stdio: 'pipe' });

  const said = await new Promise((done) => {
    const p = spawn(process.execPath, [
      join(root, 'scripts', 'check-real.mjs'), '--here', '--gguf', gguf,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (b) => { text += b; });
    p.stderr.on('data', (b) => { text += b; });
    const giveUp = setTimeout(() => { p.kill('SIGKILL'); }, HANG_MS);
    p.on('exit', (code, signal) => { clearTimeout(giveUp); done({ text, code, signal }); });
    p.on('error', (e) => { clearTimeout(giveUp); done({ text: `${text}\n${e.message}`, code: -1 }); });
  });

  /**
   * 見るもの。落ちたら、何が無かったかを名指しする。
   *
   * 数える所は `least` で本数を言う。**「どこかに在る」で書かない。**
   * backend の一行を `/で読みます/` が一つでも当たれば良い形で書いたら、
   * 二つめが log を渡していなくても素通りした（この関所をわざと
   * わざとバグを入れたときに、実際に捕まえられなかった）。確かめは 2 つあり、
   * それぞれが自分で読む側を起こすので、**2 本出るのが正しい。**
   */
  const wants = [
    ['読む側の声（backend の一行）', /で読みます/g, 2],
    ['一つめの確かめ', /(ok|NG)\s+1\+1= に 2 が返る/g, 1],
    ['二つめの確かめ', /(ok|NG)\s+read_file を呼んで、読んだマーカーを答える/g, 1],
    ['まとめの行', /件、通っていません|通りました/g, 1],
  ];
  const missing = wants
    .map(([name, re, least]) => {
      const got = said.text.match(re)?.length ?? 0;
      return got >= least ? '' : `${name}（${got}/${least} 本）`;
    })
    .filter(Boolean);

  const why = said.signal
    ? `${HANG_MS / 60_000} 分で終わりませんでした（止まっています）`
    : said.code !== 0 && said.code !== 1
      ? `白黒を付けずに ${said.code} で落ちました`
      : missing.length > 0
        ? `記録に出ていないもの: ${missing.join('・')}`
        : '';

  if (why) {
    console.log(said.text);
    console.error(`\n  CI へ出す前の確かめが通りません: ${why}`);
    process.exit(1);
  }
  console.log(`  配管は通りました（終了コード ${said.code}。答えの中身は乱数なので見ていません）`);
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
}
