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
import { findInstalled } from '../runtime/llama-install.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { formatChecks, summaryLine, type Check, type Level } from './doctor-view.ts';
import { inspectEnvironment, describeDriver } from '../runtime/environment.ts';
import { defaultModelsDir } from '../runtime/model-install.ts';
import { currentVersion, describeVersion } from '../core/version.ts';
import { resolve } from 'node:path';

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

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string, fix?: string) =>
  checks.push({ name, level, detail, fix });

/* ---------- 実行環境 ---------- */

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 6);
// 版を最初に出す。**貼ってもらった検査結果が、どの版のものか分からないと、
// 直したはずのものが直っていないように見える。**実際に一度そうなった。
add('版', 'ok', describeVersion(await currentVersion()));
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

// GPU が見えていても、ドライバ側が通っていなければ CUDA は使えない。
if (machine.vramBytes > 0) {
  const driver = await describeDriver();
  if (driver) add('GPU ドライバ', 'ok', driver);
}

/* ---------- モデルの置き場 ---------- */

const runtime = await buildRuntime(config, machine);
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
    + '     そのあと `npm run models -- --get`（まず動く軽いものが入ります）\n'
    + '     一覧は `npm run models -- --available`。名前を直接渡すこともできます\n'
    + '\n'
    + '  B. llama.cpp（Ollama に依らない。GGUF を自分で置く）\n'
    + '     `npm run llama` で llama-server をこちらが用意します（手で入れる必要はありません）。\n'
    + '     あとは GGUF を1箇所に集めて、aas.config.json に:\n'
    + '       "runtime": { "kind": "llamacpp", "modelsDir": "GGUF を置いた場所" }\n'
    + '     オフロードの計算は GGUF を直接読んで行います（docs/GGUF.md）。');
} else {
  add('モデル', 'bad', `${config.runtime?.modelsDir ?? defaultModelsDir()} に GGUF がありません`,
    '`npm run models -- --get` で取ってきます（まず動く軽いものが入ります）。\n'
    + '一覧は `npm run models -- --available`。\n'
    + '手持ちがあるなら、同じ置き場に .gguf を入れるだけでも使えます。\n'
    + `いまの置き場: ${config.runtime?.modelsDir ?? `${defaultModelsDir()}（既定）`}`);
}

/* ---------- llama-server ---------- */

// 借り物ではなく自前で持てているか。ここが空だと、
// 誰かが入れたものに相乗りしている状態になる。
const llamaPath = await findInstalled();
if (llamaPath) {
  add('llama-server', 'ok', llamaPath);
} else if (config.runtime?.kind === 'llamacpp') {
  add('llama-server', 'bad', 'まだ用意していません',
    '`npm run llama` で取ってきます。\n'
    + 'いまは PATH にある llama-server を探しますが、'
    + 'それは他の道具（LM Studio など）が入れたもので、消されると動かなくなります。');
}
// runtime.kind が llamacpp でなく、用意もしていない場合は何も言わない。
// 使っていないものが足りないのは、問題ではない。

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

/* ---------- 外側の詰まり ---------- */

/*
 * こちらの作りが正しくても、モデルを動かす層が詰まっていたら何も動かない。
 * 「うちは悪くない」で終わらせず、外側も見に行く。
 */
const envIssues = await inspectEnvironment({
  stateDir: stateDir(),
  root: resolve(config.agent?.root ?? process.cwd()),
  // 未設定でも既定の置き場を渡す。設定した人だけが検査されるのでは逆で、
  // 既定のまま使っている人こそ、全角のユーザー名で詰まる。
  modelsDir: config.runtime?.modelsDir ?? defaultModelsDir(),
  hasGpu: machine.vramBytes > 0,
});
for (const issue of envIssues) {
  add(issue.title, issue.level, issue.detail, issue.fix);
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

const style = {
  mark: { ok: c.green('  ok  '), warn: c.yellow(' 注意 '), bad: c.red(' 未了 ') },
  markWidth: 6,
  dim: c.dim,
  hint: c.yellow,
  good: c.green,
};

for (const line of formatChecks(checks, style)) console.log(line);
console.log();
console.log(summaryLine(checks, style));
console.log();
