/**
 * aas selftest — この機械で、実際に動くかを一通り確かめる。
 *
 * こちらの手元は Linux で、マグロさんの手元は Windows。
 * **こちらで通っても、そちらで通る証明にはならない**ものが溜まる。
 *   ・起動用のバッチが開くか
 *   ・検査が現実的な時間で終わるか
 *   ・llama-server の CUDA 版が取れるか
 * そのたびに「これを試して、出力を貼ってください」と頼むのは、
 * 頼む側も答える側も手間なので、一回で済む形にまとめる。
 *
 * 直さない。**見て、そのまま貼れる形で出す**だけ。
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { detectMachine, describeMachine } from '../runtime/machine.ts';
import { findInstalled, defaultBinDir } from '../runtime/llama-install.ts';
import { pickAsset } from '../runtime/llama-release.ts';
import { loadConfig } from '../config.ts';
import { padTo, displayWidth } from './width.ts';

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
  add('起動用', crlf === wantCrlf && !bom,
    `${launcher}: 改行=${crlf ? 'CRLF' : 'LF'}（期待=${wantCrlf ? 'CRLF' : 'LF'}）`
    + `${bom ? ' / BOM あり（cmd.exe が読み違えます）' : ''}`);
} catch (e) {
  add('起動用', false, `${launcher} を読めません: ${(e as Error).message}`);
}

/* ---------- llama-server ---------- */
const binDir = defaultBinDir();
const llama = await findInstalled(binDir);
if (llama) {
  const out = await run(llama, ['--version']);
  const works = /version/i.test(out.text);
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
add('配布物の選択', choice !== undefined,
  choice ? `${choice.why} → ${choice.name}` : 'この環境に合うものが選べません');

/* ---------- モデル ---------- */
const { config } = loadConfig();
const modelsDir = config.runtime?.modelsDir ?? join(defaultBinDir(), '..', 'models');
try {
  const { readdir } = await import('node:fs/promises');
  const ggufs = (await readdir(modelsDir)).filter((f) => f.toLowerCase().endsWith('.gguf'));
  add('モデル', ggufs.length > 0,
    ggufs.length > 0 ? `${ggufs.length} 件: ${ggufs.slice(0, 3).join(', ')}` : `${modelsDir} は空です`);
} catch {
  add('モデル', false, `${modelsDir} がありません（npm run models -- --get で取ってきます）`);
}

/* ---------- 検査 ---------- */
// 通るかどうかだけでなく、何秒かかるかを見る。
// Windows では 242 秒かかっていた（4GB の仮ファイルを書いていたため）。
const started = Date.now();
const test = await run(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], root);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const passed = /^# fail 0$/m.test(test.text);
const counts = /^# pass (\d+)$/m.exec(test.text)?.[1] ?? '?';
add('検査', passed, `${seconds}秒 / ${counts}件通過${passed ? '' : ' — 失敗あり'}`);

/* ---------- 出力 ---------- */
const mark = (ok: boolean | undefined) => (ok === undefined ? '—' : ok ? 'ok' : 'NG');
// 日本語は2つ分の幅を取る。文字数で揃えると、日本語の行だけずれる。
const nameWidth = Math.max(...results.map((r) => displayWidth(r.name))) + 2;
console.log('```');
console.log('AdaptiveAIStudio — selftest');
console.log('');
for (const r of results) {
  console.log(`${padTo(mark(r.ok), 5)}${padTo(r.name, nameWidth)}${r.detail}`);
}
if (!passed) {
  console.log('');
  console.log('検査の失敗部分:');
  for (const line of test.text.split('\n').filter((l) => l.startsWith('not ok')).slice(0, 10)) {
    console.log(`  ${line}`);
  }
}
console.log('```');
console.log('');
console.log('この内容をそのまま貼ってください。');

const bad = results.filter((r) => r.ok === false).length;
process.exit(bad > 0 ? 1 : 0);

function run(command: string, args: string[], cwd = process.cwd()): Promise<{ text: string }> {
  return new Promise((resolve) => {
    let text = '';
    const child = spawn(command, args, { cwd });
    const on = (b: Buffer) => { text += b.toString(); };
    child.stdout?.on('data', on);
    child.stderr?.on('data', on);
    child.on('error', (e) => resolve({ text: e.message }));
    child.on('close', () => resolve({ text }));
  });
}
