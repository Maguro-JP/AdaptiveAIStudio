/**
 * aas doctor — いま何が足りていないかを、一枚で出す。
 *
 * 「入れて、動かす」までの間に詰まる箇所は決まっている。
 * その都度こちらに訊かないと分からない、という状態にしない。
 *
 * 大事なのは、駄目出しで終わらせないこと。
 * 足りないものには**次に打つ一手**を必ず添える。
 */
import { loadConfig, enabledProviders } from '../config.ts';
import { MachineCache, describeMachine } from '../runtime/machine.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { padTo } from './width.ts';

/** Windows と Unix でコマンドが違うものは、その環境のものを出す。 */
const isWindows = process.platform === 'win32';
const copyCmd = (from: string, to: string) =>
  isWindows ? `copy ${from} ${to}` : `cp ${from} ${to}`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

type Level = 'ok' | 'warn' | 'bad';

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** 足りないときに、次に打つ一手 */
  fix?: string;
}

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string, fix?: string) =>
  checks.push({ name, level, detail, fix });

/* ---------- 実行環境 ---------- */

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 6);
add('Node.js', nodeOk ? 'ok' : 'bad', `v${process.versions.node}`,
  nodeOk ? undefined
    : 'v22.6 以降が要ります（型を剥がしながら実行する機能を使うため）。https://nodejs.org から入れ直してください。');

/* ---------- 設定 ---------- */

const { config, source } = loadConfig();
add('設定', 'ok', source,
  source.includes('なし')
    ? `既定のまま動きます。変えたくなったら \`${copyCmd('aas.config.example.json', 'aas.config.json')}\`。`
    : undefined);

/* ---------- 機械 ---------- */

const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
add('この機械', 'ok', describeMachine(machine));

/* ---------- モデルの置き場 ---------- */

const runtime = buildRuntime(config, machine);
let models: Awaited<ReturnType<typeof runtime.list>> = [];
try {
  models = await runtime.list();
} catch (e) {
  add('モデル', 'bad', `一覧を取れません: ${(e as Error).message}`);
}

if (models.length > 0) {
  add('モデル', 'ok', `${models.length} 件: ${models.slice(0, 3).map((m) => m.ref).join(', ')}`
    + (models.length > 3 ? ' …' : ''));
} else if (runtime.id === 'ollama') {
  // 動かす土台は選べる。Ollama は借り物で、そうでない道も用意してある。
  // ここで片方しか案内しないと、必須のように見えてしまう。
  add('モデル', 'bad', 'モデルを動かす土台がまだありません',
    'どちらかを選んでください。\n'
    + '\n'
    + '  A. Ollama（手早い。まずはこちら）\n'
    + '     https://ollama.com から入れて `ollama serve`\n'
    + '     そのあと `ollama pull qwen3:30b-a3b`（8GB VRAM ならこれが最適解）\n'
    + '\n'
    + '  B. llama.cpp（Ollama に依らない。GGUF を自分で置く）\n'
    + '     llama-server を用意し、GGUF を1箇所に集めて、aas.config.json に:\n'
    + '       "runtime": { "kind": "llamacpp",\n'
    + '                    "command": "llama-server の場所",\n'
    + '                    "modelsDir": "GGUF を置いた場所" }\n'
    + '     オフロードの計算は GGUF を直接読んで行います（docs/GGUF.md）。');
} else {
  add('モデル', 'bad', `${config.runtime?.modelsDir ?? '(modelsDir 未設定)'} に GGUF がありません`,
    '.gguf ファイルを modelsDir に置いてください。\n'
    + `いまの modelsDir: ${config.runtime?.modelsDir ?? '未設定（aas.config.json で指定してください）'}`);
}

/* ---------- 繋ぎ先 ---------- */

for (const p of enabledProviders(config)) {
  const label = `接続 (${p.id})`;
  if (p.kind === 'anthropic') {
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    if (!key) {
      add(label, 'warn', `${p.apiKeyEnv} が未設定`,
        'ローカルだけで使うなら、このままで構いません。');
      continue;
    }
    try {
      await import('@anthropic-ai/sdk');
      add(label, 'ok', 'SDK あり / APIキーあり');
    } catch {
      add(label, 'warn', 'APIキーはあるが SDK が入っていません', '`npm install` を実行してください。');
    }
    continue;
  }
  try {
    const res = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    add(label, res.ok ? 'ok' : 'warn', `${p.baseUrl} — HTTP ${res.status}`);
  } catch (e) {
    add(label, 'bad', `${p.baseUrl} に繋がりません`,
      p.id === 'ollama'
        ? (runtime.id === 'llamacpp'
          // llamacpp を使うなら、Ollama の口は無効にしておいた方が静か。
          ? 'llamacpp を使う設定になっています。Ollama は使わないなら、'
            + 'aas.config.json の providers から ollama を消すか enabled: false にしてください。'
          : '`ollama serve` が動いているか確認してください。')
        : undefined);
  }
}

/* ---------- 保存先 ---------- */

try {
  const files = await readdir(stateDir());
  add('記録の置き場', 'ok', `${stateDir()}（${files.length} 件）`);
} catch {
  add('記録の置き場', 'ok', `${stateDir()}（まだ空。初回起動で作られます）`);
}

/* ---------- 出す ---------- */

console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — doctor\n'));

const mark = { ok: c.green('  ok  '), warn: c.yellow(' 注意 '), bad: c.red(' 未了 ') };
for (const check of checks) {
  console.log(`${mark[check.level]} ${padTo(check.name, 16)}${c.dim(check.detail)}`);
  if (check.fix) {
    // 続きの行も、矢印の下に揃える。ぶら下がりが崩れると読みにくい。
    const [head, ...rest] = check.fix.split('\n');
    console.log(c.yellow(`       → ${head}`));
    for (const line of rest) console.log(c.yellow(`         ${line}`));
  }
}

const bad = checks.filter((x) => x.level === 'bad');
console.log();
if (bad.length === 0) {
  console.log(c.green('動かせます。') + c.dim('  npm run ui  で画面、 npm run agent  で端末。'));
} else {
  console.log(c.yellow(`${bad.length} 件かたづければ動きます。`)
    + c.dim(' 画面（npm run ui）は、モデルが無くても開けます。'));
}
console.log();
