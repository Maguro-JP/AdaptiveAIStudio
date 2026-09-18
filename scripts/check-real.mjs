/**
 * 本物の重みを取ってきて、配る形の中で「本当に答えるか」を見る。
 *
 *   node scripts/check-real.mjs                  配る形に組み、その中で
 *   node scripts/check-real.mjs --here           組まずに、この作業場で
 *   node scripts/check-real.mjs --repo <リポジトリ> --quant <量子化>
 *   node scripts/check-real.mjs --gguf <手元の .gguf>   落とさずに、置いて回す
 *
 * `--gguf` は配管の確かめ用。配布元へ繋がらない場所で、組んだ中の道（`.portable` →
 * `data/models` → 読む → 答える）が繋がっていることだけを見る。乱数の模型を渡せば
 * **落ちるのが正しい**（答えの中身を見ているので）。
 *
 * 既定は `unsloth/Qwen3-0.6B-GGUF` の q4_k_m（約 400MB）。利用者が実機で使うのは
 * Qwen3 系なので、同じ家族の小さいものを選んでいる（考えごと <think> をする）。
 *
 * 取ってくるのは製品の道（`installModel`）。一覧を調べて量子化で選ぶ所から、
 * 続きから取る所まで、配った先で使われるものと同じ。**ここが初めて、配布元へ
 * 本当に繋いで取ってくる確かめになる**（開発している場所からは繋がらない）。
 *
 * 見るのは `scripts/real-answer.mjs`（足し算に本物の文字で 2・ツールを呼んで読む）。
 * 落ちたら終了コード 1。
 */
import { spawn } from 'node:child_process';
import { rm, mkdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installModel, human, mmss } from '../src/runtime/model-install.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, fallback) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const repo = valueOf('--repo', 'unsloth/Qwen3-0.6B-GGUF');
const quant = valueOf('--quant', 'q4_k_m');
const here = has('--here');
const gguf = valueOf('--gguf', '');
const out = join(root, 'dist', 'check-real');

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((ok, ng) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
    p.on('error', ng);
    p.on('exit', (code) => (code === 0 ? ok() : ng(new Error(`${cmd} が ${code} で終わりました`))));
  });
}

let node = process.execPath;
let app = root;
let modelsDir = join(out, 'models');
const env = { ...process.env };

if (here) {
  console.log('== この作業場で（組まない）');
  await rm(out, { recursive: true, force: true });
  await mkdir(modelsDir, { recursive: true });
  // モデルの保存先と記録を、この確かめの中だけに閉じる。
  env.AAS_HOME = join(out, 'home');
  env.AAS_MODELS_DIR = modelsDir;
} else {
  console.log('== 配る形に組む');
  await rm(out, { recursive: true, force: true });
  await run(process.execPath, [join(root, 'scripts', 'bundle.mjs'), '--node-here', '--out', out]);
  node = join(out, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  app = join(out, 'app');
  modelsDir = join(out, 'data', 'models');
  if (!(await stat(node).catch(() => undefined))) {
    console.error(`同梱の Node が見つかりません: ${node}`);
    process.exit(1);
  }
}

const began = Date.now();
if (gguf) {
  console.log(`\n== 落とさずに、手元の GGUF を置く: ${gguf}`);
  await mkdir(modelsDir, { recursive: true });
  await copyFile(gguf, join(modelsDir, basename(gguf)));
} else try {
  console.log(`\n== 本物の重みを取ってくる: ${repo}（${quant}）`);
  let lastPct = -10;
  const got = await installModel({
    entry: { id: 'check-real', repo, quant, ollama: '', approxGB: 0.5, note: '', license: '' },
    modelsDir,
    onProgress: (line) => console.log(`  ${line}`),
    // 進み具合は 10% ごとに一行。1.5 秒ごとに出すと、CI の記録が埋まる。
    onStatus: (s) => {
      const pct = s.pct ?? 0;
      if (pct - lastPct >= 10 || (s.totalBytes && s.doneBytes >= s.totalBytes)) {
        lastPct = pct;
        console.log(`  ${pct}%  ${human(s.doneBytes)}${s.totalBytes ? ` / ${human(s.totalBytes)}` : ''}  ${human(s.bytesPerSec)}/s${s.etaSec !== undefined ? `  残り ${mmss(s.etaSec)}` : ''}`);
      }
    },
  });
  console.log(`  置きました: ${got.path}（${human(got.bytes)}、${mmss((Date.now() - began) / 1000)}）`);
} catch (e) {
  console.error(`\n取ってこられませんでした:\n${e?.message ?? e}`);
  process.exit(1);
}

console.log('\n== その中で、本当に答えるかを見る');
try {
  await run(node, [join(app, 'scripts', 'real-answer.mjs')], { cwd: app, env });
} catch (e) {
  console.error(`\n== 本物の重みでは答えられていません（${e.message}）`);
  process.exit(1);
}

console.log('\n== 本物の重みで、答えが返りました');
console.log(`  ${here ? 'この作業場で' : `配る形（${out}）の中で`}、${gguf ? basename(gguf) : `${repo} の ${quant}`}。`);
console.log('  確かめたのは、この機械の CPU で読んだ範囲です。GPU の道は見ていません。');
