/**
 * 型検査 → 検査 → **画面を押して回る**を、続けて回す。
 *
 * `npm run typecheck && npm test` と書くと npm 無しでは動かせない
 * （scripts/run.mjs は node 一つで仕事を起こす作り。`&&` は shell の言葉）。
 * だから node で順に起こす。どれか落ちたら、その終了コードで終わる。
 *
 * **画面を押して回るところまでを、ここに入れる。**
 * 「確かめた」と言いながら画面を一度も押さずに出し、
 * 「設定の選択肢が全部空」「畳んだら二度と開けない」を利用者に見つけさせた。
 * 検査を通したという言葉が、画面を押したことを含むようにする。
 *
 * 押して回るには playwright-core と Chromium が要る。無い場所（CI・bundle）では
 * **飛ばして、そう言う。**黙って通すと、また押さずに「通った」と言うことになる。
 */
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { describeNotChecked } from './not-checked.mjs';
import { findBrowser } from './find-browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(label, args, env) {
  console.log(`\n== ${label}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root, ...(env ? { env } : {}) });
  return r.status ?? 1;
}

/**
 * 空いている口を一つ借りる。決め打つと、二重に走らせたときに当たる。
 *
 * **立ってから訊く。**listen は非同期なので、直後に address() を見ると null。
 */
async function freePort() {
  const s = createServer();
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const { port } = s.address();
  await new Promise((done) => s.close(done));
  return port;
}

/**
 * 押して回るものが使えるか。使えないなら、その理由。
 *
 * ブラウザの場所を決め打っていた（この機械にしか無い道）。**Windows で
 * 回すと、押して回る部分だけが静かに飛ぶ。**配る先で回したときに限って、
 * いちばん壊れやすい所を見ないことになる。Edge は Windows に必ず在る。
 */
function sweepReady() {
  if (!existsSync(join(root, 'node_modules', 'playwright-core'))) {
    return { ok: false, why: 'playwright-core が入っていません' };
  }
  return findBrowser({ platform: process.platform, env: process.env, exists: existsSync });
}

/**
 * 画面を立ち上げて、押して回る。
 *
 * モデルを置いていない状態で回す。**いちばん壊れやすく、いちばん多い形**で、
 * かつ GGUF を用意しなくてよい（何GBも要らない）。
 */
async function sweep() {
  const ready = sweepReady();
  if (!ready.ok) {
    console.log(`\n== 画面を押して回る（飛ばします: ${ready.why}）`);
    return 0;
  }
  console.log('\n== 画面を押して回る');

  const home = mkdtempSync(join(tmpdir(), 'aas-check-'));
  /*
   * **使い込んだ状態を作ってから押す。**
   *
   * ここはまっさらな置き場で立ち上げていたので、溜まってから出る崩れが
   * 一度も再現しなかった。実際に「戻す」の一覧が 30 件並んで横の並びを占領し、
   * その下の「会話」と「作業場」が画面の外へ出た。押せないので、機能が
   * 在っても無いのと同じになる。**利用者が先に見つけた。**
   *
   * 溜まるものは、溜めた状態で押す。
   */
  const undoDir = join(home, 'undo');
  mkdirSync(undoDir, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    const id = `u-check-${i}`;
    writeFileSync(join(undoDir, `${id}.json`), JSON.stringify({
      id,
      at: Date.now() - i * 60_000,
      request: `src/a.txt を書き換えて（検査のために作ったもの ${i}）`,
      paths: ['src/a.txt'],
      files: [{ path: 'src/a.txt', content: '' }],
    }));
  }
  /*
   * 会話も溜めておく。
   *
   * ここまで、押して回るときの一覧は**必ず空**だった。空の一覧では
   * 「開く」も「消す」も押す相手がいないので、**素通りしていた。**
   * 利用者からは「会話が消せない」「新規で会話が開けない」と言われた。
   * その二つを、こちらでは一度も押していなかったことになる。
   */
  const convDir = join(home, 'conversations');
  mkdirSync(convDir, { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    const id = `c20260101-00000${i}-000${i}`;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    writeFileSync(join(convDir, `${id}.jsonl`), [
      JSON.stringify({ t: 'meta', id, title: `検査のために作った会話 ${i}`, createdAt: at }),
      JSON.stringify({ t: 'msg', at, m: { role: 'user', content: `確かめ ${i}` } }),
      JSON.stringify({ t: 'msg', at, m: { role: 'assistant', content: `はい ${i}` } }),
    ].join('\n') + '\n');
  }

  const port = await freePort();
  const ui = spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', 'ui.ts'),
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AAS_HOME: home,
      AAS_CONFIG: join(home, 'aas.config.json'),
      AAS_UI_PORT: String(port),
      // 画面を開かない。開けても、この場では見る人がいない。
      AAS_UI_NO_OPEN: '1',
    },
  });
  let log = '';
  ui.stdout.on('data', (b) => { log += String(b); });
  ui.stderr.on('data', (b) => { log += String(b); });

  try {
    // 立ち上がるまで待つ。決め打ちの秒数で待つと、遅い機械で落ちる。
    const until = Date.now() + 60_000;
    for (;;) {
      if (ui.exitCode !== null) {
        console.error(`画面が立ち上がりませんでした:\n${log.slice(-800)}`);
        return 1;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/info`);
        if (r.ok) break;
      } catch { /* まだ立っていない */ }
      if (Date.now() > until) {
        console.error(`画面が立ち上がりませんでした（時間切れ）:\n${log.slice(-800)}`);
        return 1;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    return run('押して回る', [
      join(root, 'scripts', 'sweep.mjs'), `http://127.0.0.1:${port}/`, '--no-model',
    ], { ...process.env, AAS_SWEEP_BROWSER: ready.browser });
  } finally {
    ui.kill('SIGKILL');
  }
}

/**
 * 本物のモデルで、中で読む道を通す。
 *
 * **差し替えの試験は「差し替えが動く」ことしか言っていない。**
 * ここまで、中で読む道は一度も本物で動かしていなかった。
 * node-llama-cpp が無い場所では、script 側が自分で飛ばす。
 */
function realModel() {
  console.log('\n== 本物のモデルで通す');
  return run('本物のモデル', [join(root, 'scripts', 'real-model.mjs')]);
}

/**
 * 数え方が本物と同じか。
 *
 * 窓の勘定はここに乗っている。ずれると、落としてはいけないものを落とし、
 * 「モデルが馬鹿だ」に見える。自分の実装を自分で確かめない。
 */
function tokenizer() {
  console.log('\n== 数え方を、本物と突き合わせる');
  return run('数え方', [join(root, 'scripts', 'tokenizer-conformance.mjs')]);
}

const typecheck = run('型検査', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
if (typecheck !== 0) process.exit(typecheck);

const tests = run('検査', [join(root, 'scripts', 'run-tests.mjs')]);
if (tests !== 0) process.exit(tests);

const ready = sweepReady();
const swept = await sweep();
if (swept !== 0) process.exit(swept);
const counted = tokenizer();
if (counted !== 0) process.exit(counted);
const real = realModel();
if (real !== 0) process.exit(real);

/*
 * **確かめていないことを、通ったときにこそ言う。**
 *
 * 中身は `scripts/not-checked.mjs`。走らせないと出ない文章は書いたことに
 * ならないので、**そのものを検査にかけられる形**にして外に出してある。
 */
let head = '';
try {
  head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .stdout.trim();
} catch { /* git が無い場所でも出す */ }
console.log(`\n${describeNotChecked({
  platform: process.platform,
  sweep: ready.ok ? 'ran' : ready.why,
  realModel: existsSync(join(root, 'node_modules', 'node-llama-cpp')),
}, head)}`);
process.exit(0);
