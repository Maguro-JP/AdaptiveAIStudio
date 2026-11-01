/**
 * 言語モデルを、使う人と同じ道（`check-user.mjs`）で比べる。
 *
 * モデルごとに、データをまっさらにして（モデル以外を消して）配る形を起こし、
 * 作る（fizzbuzz.js）・直す（calc.js）の 2 つの頼みを画面から送る。
 * 出来たファイルを動かして判定する。答えの文面では判定しない。
 *
 * 比べる条件をそろえるため、保存先にはそのモデル 1 つだけを置く（`AAS_MODELS_DIR` に別の場所を渡す）。
 * 元のモデルのファイルは動かさない（固いリンクを作る。作れなければ写す）。
 *
 * 使い方:
 *   node scripts/model-eval.mjs --bundle <配る形のフォルダ> --model <.gguf> [--model …] [--out <結果の json>] [--port 4180]
 *
 * 結果は 1 モデル 1 行で、通ったか・かかった秒・最後の判定の行を書く。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, linkSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]); });
  return out;
}

const bundle = args('--bundle')[0];
const models = args('--model').map((m) => resolve(m));
const out = args('--out')[0];
const port = Number(args('--port')[0] ?? 4180);
if (!bundle || models.length === 0) {
  console.error('使い方: node scripts/model-eval.mjs --bundle <配る形のフォルダ> --model <.gguf> [--model …] [--out <結果の json>]');
  process.exit(2);
}
const data = join(bundle, 'data');
const startSh = join(bundle, 'app', 'start.sh');
if (!existsSync(startSh)) {
  console.error(`配る形の入口がありません: ${startSh}`);
  process.exit(2);
}

/** モデル以外のデータを消す。前の回の会話や途中の仕事を引き継がせない（引き継ぐと古い仕事の続きを始める）。 */
function wipe() {
  if (!existsSync(data)) return;
  for (const n of readdirSync(data)) {
    if (n === 'models') continue;
    rmSync(join(data, n), { recursive: true, force: true });
  }
}

/** そのモデル 1 つだけの保存先を作る。 */
function only(model) {
  const dir = join(bundle, 'eval-models', basename(model, '.gguf'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(model));
  try { linkSync(model, dest); } catch { copyFileSync(model, dest); }
  return dir;
}

function runOne(model) {
  wipe();
  const dir = only(model);
  const began = Date.now();
  return new Promise((resolveRun) => {
    let tail = '';
    const child = spawn(process.execPath, [
      join(here, 'check-user.mjs'), '--start', `sh "${startSh}" ui`, '--port', String(port), '--find', data,
    ], { env: { ...process.env, AAS_MODELS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (b) => { const t = b.toString(); process.stdout.write(t); tail = (tail + t).slice(-4000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('exit', (code) => {
      const verdict = tail.split('\n').reverse().find((l) => l.startsWith('== ')) ?? '';
      rmSync(dir, { recursive: true, force: true });
      resolveRun({
        model: basename(model),
        bytes: statSync(model).size,
        passed: code === 0,
        seconds: Math.round((Date.now() - began) / 1000),
        verdict,
      });
    });
  });
}

const results = [];
for (const m of models) {
  console.log(`\n### ${basename(m)}`);
  results.push(await runOne(m));
}
console.log('\n結果:');
for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.model}  ${r.seconds}秒  ${r.verdict}`);
if (out) writeFileSync(out, `${JSON.stringify({ when: new Date().toISOString(), results }, null, 2)}\n`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
