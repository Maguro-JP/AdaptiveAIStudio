/**
 * aas selftest — この機械で、実際に動くかを一通り確かめる。
 *
 * 開発は Linux、利用は Windows。
 * **こちらで通っても、そちらで通る証明にはならない**ものが溜まる。
 *   ・起動用のバッチが開くか
 *   ・検査が現実的な時間で終わるか
 *   ・llama-server の CUDA 版が取れるか
 * そのたびに「これを試して、出力を貼ってください」と頼むのは、
 * 頼む側も答える側も手間なので、一回で済む形にまとめる。
 *
 * 直さない。**見て、そのまま貼れる形で出す**だけ。
 */
import { testsPassed } from './tests-verdict.ts';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { detectMachine, describeMachine } from '../runtime/machine.ts';
import { findInstalled, defaultBinDir, answeredVersion } from '../runtime/llama-install.ts';
import { runtimeEnv } from '../runtime/llama-env.ts';
import { defaultModelsDir } from '../runtime/model-install.ts';
import { pickAsset } from '../runtime/llama-release.ts';
import { loadConfig } from '../config.ts';
import { askOnce, describeOneTurn } from './ask-once.ts';
import { padTo, displayWidth } from './width.ts';
import { chunkReader } from '../core/text.ts';
import { saveReport, tellWhereItWent } from './report-file.ts';
import { productRoot } from '../core/home.ts';
import { stateDir } from '../core/autopilot-setup.ts';
const LLAMA_LIB = 'node-llama-cpp'; // 型検査に解決させない（src/runtime/inproc.ts 参照）

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Result {
  name: string;
  ok: boolean | undefined;   // undefined = 確かめられなかった
  detail: string;
}

const results: Result[] = [];
const add = (name: string, ok: boolean | undefined, detail: string) => {
  results.push({ name, ok, detail });
};

/* ---------- この機械 ---------- */
const machine = await detectMachine();
add('環境', true, `${process.platform}-${process.arch} / Node ${process.versions.node}`);
add('機械', true, describeMachine(machine));

/* ---------- 起動用 ---------- */
// Windows のバッチは、改行と文字コードで開かないことがある。
const launcher = process.platform === 'win32' ? 'start.cmd' : 'start.sh';
try {
  const buf = await readFile(join(root, launcher));
  const crlf = buf.includes(Buffer.from('\r\n'));
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const wantCrlf = process.platform === 'win32';
  // 文字集合も見る。cmd.exe はバッチを console の文字集合で読むので、
  // UTF-8 で置くと日本語が化けるだけでなく**行が壊れて断片が実行される**。
  // 実際にそうなった。BOM の有無だけでは気づけない。
  let utf8 = false;
  if (wantCrlf) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      utf8 = buf.some((b) => b >= 0x80); // ASCII だけなら、どちらでも同じ
    } catch { utf8 = false; }
  }
  add('起動用', crlf === wantCrlf && !bom && !utf8,
    `${launcher}: 改行=${crlf ? 'CRLF' : 'LF'}（期待=${wantCrlf ? 'CRLF' : 'LF'}）`
    + `${bom ? ' / BOM あり（cmd.exe が読み違えます）' : ''}`
    + `${utf8 ? ' / UTF-8（CP932 で置いてください。行が壊れます）' : ''}`);
} catch (e) {
  add('起動用', false, `${launcher} を読めません: ${(e as Error).message}`);
}

/**
 * 呼んでいる間だけ、向こうの console.warn を黙らせる。
 *
 * node-llama-cpp は binary が無いと「A prebuilt binary was not found」を
 * console.warn に**直に**書く（logLevel を通らない。実測）。この出力は
 * 利用者がそのまま貼るものなので、こちらの言葉で言い直す分だけを残す。
 */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try { return await run(); } finally { console.warn = warn; }
}

/* ---------- この中で読む道 ---------- */

// 実行ファイルを増やさずに GGUF を読む道。**この機械で本当に読めるか**は、
// ここでしか分からない（bundle には入れてあるが、機械が違えば動かない）。
try {
  const lib = await import(LLAMA_LIB) as { getLlama: (o?: { build?: 'never'; logLevel?: 'error' }) => Promise<unknown> };
  add('この中で読む', true, 'node-llama-cpp を読み込めました（実行ファイルは増えません）');
  try {
    // 組み立てに走らせない。無いなら無いと、すぐ言わせる。
    await quietly(() => lib.getLlama({ build: 'never', logLevel: 'error' }));
    add('この中で読む（土台）', true, 'この機械むけの binary が動きました');
  } catch (e) {
    add('この中で読む（土台）', false,
      `この機械むけの binary がありません: ${(e as Error).message.slice(0, 160)}`);
  }
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  // 「入っていない」と「入っているのに壊れている」は別の話。
  // 後者を前者の顔で言っていて、bundle の欠けに気づけなかった。
  if (code === 'ERR_MODULE_NOT_FOUND') {
    add('この中で読む', undefined, 'node-llama-cpp が入っていません（setup.exe や portable には入っています）');
  } else {
    add('この中で読む', false,
      `node-llama-cpp は在るのに読み込めません（欠けています）: ${(e as Error).message.slice(0, 160)}`);
  }
}

/* ---------- llama-server ---------- */
const binDir = defaultBinDir();
const llama = await findInstalled(binDir);
if (llama) {
  // 本番の起動と同じ env（隣の共有ライブラリを見つけさせる）で、時間を区切って起こす
  const out = await run(llama, ['--version'], process.cwd(), { env: runtimeEnv(llama), timeout: 30_000 });
  const works = answeredVersion(out.text);
  add('llama-server', works, works ? out.text.trim().split('\n')[0]! : `動きません: ${out.text.trim().slice(0, 200)}`);
} else {
  add('llama-server', undefined, `まだ用意していません（npm run llama で取ってきます）。置き場: ${binDir}`);
}

// この機械で、どれが選ばれるはずかを見せる。取りに行く前に分かる。
const hasNvidia = /nvidia|geforce|rtx|quadro|tesla/i.test(machine.gpuName ?? '');
const sample = [
  'llama-bin-win-cuda-cu12.4-x64.zip', 'llama-bin-win-avx2-x64.zip', 'llama-bin-win-arm64.zip',
  'llama-bin-ubuntu-cuda-x64.zip', 'llama-bin-ubuntu-x64.zip',
  'llama-bin-macos-arm64.zip', 'llama-bin-macos-x64.zip',
];
const choice = pickAsset(sample, { platform: process.platform, arch: process.arch, hasNvidia });
add('どれを使うかの選択', choice !== undefined,
  choice ? `${choice.why} → ${choice.name}` : 'この環境に合うものが選べません');

/* ---------- モデル ---------- */
const { config } = loadConfig();
const modelsDir = config.runtime?.modelsDir ?? defaultModelsDir();
let ggufs: string[] = [];
try {
  const { readdir } = await import('node:fs/promises');
  const { looksLikeGguf } = await import('../runtime/inproc.ts');
  const named = (await readdir(modelsDir)).filter((f) => f.toLowerCase().endsWith('.gguf'));
  /*
   * **置いてある数ではなく、読める数で言う。**
   *
   * `.gguf` という名前が在るだけで「1 件」と数えていた。中身が配布元の
   * 同意頁の HTML でも ok になり、送ると 503 で断られる（doctor 側では
   * 同じことを一度直している）。**在ることを、使えることとして言わない。**
   */
  for (const name of named) {
    if (await looksLikeGguf(join(modelsDir, name))) ggufs.push(name);
  }
  const broken = named.length - ggufs.length;
  add('モデル', ggufs.length > 0, ggufs.length > 0
    ? `${ggufs.length} 件: ${ggufs.slice(0, 3).join(', ')}`
      + (broken > 0 ? `（読めないものが ${broken} 件）` : '')
    : named.length > 0
      ? `${named.length} 件ありますが、どれも GGUF として読めません（落とし直してください）`
      : `${modelsDir} は空です`);
} catch {
  add('モデル', false, `${modelsDir} がありません（npm run models -- --get で取ってきます）`);
}

/* ---------- 本当に答えるか（送って返る） ---------- */
/*
 * 中身は `src/cli/ask-once.ts`。**走らせる口が二つ（ここと
 * `scripts/real-model.mjs`）在るので、中身は一つにする。**
 * 出す言葉もそちらに置く（人が読む一行と中身が割れると、片方だけ直す）。
 */
if (ggufs.length === 0) {
  add('送って返る', undefined, 'モデルが無いので確かめていません');
} else {
  try {
    const got = await askOnce(config, { log: (t) => console.log(`  ${t}`) });
    const said = describeOneTurn(got);
    add('送って返る', said.ok, said.detail);
  } catch (e) {
    add('送って返る', false, (e as Error).message);
  }
}

/* ---------- 検査 ---------- */
// 通るかどうかだけでなく、何秒かかるかを見る。
// Windows では 242 秒かかっていた（4GB の仮ファイルを書いていたため）。
const started = Date.now();
const test = await run(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], root);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const passed = testsPassed(test.text, test.code);
const counts = /^# pass (\d+)$/m.exec(test.text)?.[1] ?? '?';
add('検査', passed, `${seconds}秒 / ${counts}件通過${passed ? '' : ' — 失敗あり'}`);

/* ---------- 出力 ---------- */
const mark = (ok: boolean | undefined) => (ok === undefined ? '—' : ok ? 'ok' : 'NG');
// 日本語は2つ分の幅を取る。文字数で揃えると、日本語の行だけずれる。
const nameWidth = Math.max(...results.map((r) => displayWidth(r.name))) + 2;
const body = ['AdaptiveAIStudio — selftest', ''];
for (const r of results) {
  body.push(`${padTo(mark(r.ok), 5)}${padTo(r.name, nameWidth)}${r.detail}`);
}
if (!passed) {
  body.push('');
  body.push('検査の失敗部分:');
  for (const line of test.text.split('\n').filter((l) => l.startsWith('not ok')).slice(0, 10)) {
    body.push(`  ${line}`);
  }
}
console.log('```');
for (const line of body) console.log(line);
console.log('```');
console.log('');
/*
 * **貼らせない。ファイルを一つ出す。**
 *
 * ここは「この内容をそのまま貼ってください」で終わっていた。cmd の画面から
 * 文字を拾うのは Windows ではとても面倒で（右クリック→範囲選択→Enter、
 * 途中で切れる）、結局「試す係をやってください」と同じになる。
 */
for (const line of tellWhereItWent(
  await saveReport('selftest', body.join('\n'), [join(stateDir(), 'reports'), stateDir(), productRoot()]),
)) console.log(line);

const bad = results.filter((r) => r.ok === false).length;
process.exit(bad > 0 ? 1 : 0);

function run(
  command: string, args: string[], cwd = process.cwd(), extra: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ text: string; code: number | null }> {
  return new Promise((resolve) => {
    let text = '';
    /*
     * **起こせなかったことを、投げさせない。**Node の spawn は ENOENT・EACCES 等だけを 'error' で知らせ、
     * それ以外（Windows の壊れた .exe の EFTYPE、ERROR_ACCESS_DENIED の EPERM、方針で止められた UNKNOWN、
     * .cmd/.bat の EINVAL、Linux の ENOEXEC）はその場で投げる。ここで投げると Promise ごと落ち、
     * 一覧も報告のファイルも出ないまま Node の積み上げだけが残る。
     */
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, ...extra });
    } catch (e) {
      resolve({ text: (e as Error).message, code: null });
      return;
    }
    const on = (read: (c: Buffer) => string) => (b: Buffer) => { text += read(b); };
    child.stdout?.on('data', on(chunkReader()));
    child.stderr?.on('data', on(chunkReader()));
    child.on('error', (e) => resolve({ text: e.message, code: null }));
    child.on('close', (code) => resolve({ text, code }));
  });
}
