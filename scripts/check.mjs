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
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

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

/** 押して回る道具が使えるか。使えないなら、その理由。 */
function sweepReady() {
  const browser = process.env.AAS_SWEEP_BROWSER
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (!existsSync(join(root, 'node_modules', 'playwright-core'))) {
    return { ok: false, why: 'playwright-core が入っていません' };
  }
  if (!existsSync(browser)) return { ok: false, why: `ブラウザがありません: ${browser}` };
  return { ok: true, browser };
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
    ]);
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

const swept = await sweep();
if (swept !== 0) process.exit(swept);
const counted = tokenizer();
if (counted !== 0) process.exit(counted);
process.exit(realModel());
