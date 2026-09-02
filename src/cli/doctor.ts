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
import { installRoot } from '../core/home.ts';
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
  // 名前だけ .gguf の別物と、記憶に載らないものは、ここで言う。
  // 送ってから 503 を見るより、貼る出力で先に分かるほうが早い。
  if (runtime.id === 'inproc') {
    const { looksLikeGguf, tooBigForRam } = await import('../runtime/inproc.ts');
    const { totalmem } = await import('node:os');
    const dir = config.runtime?.modelsDir ?? modelsDir();
    for (const m of models) {
      if (!(await looksLikeGguf(join(dir, m.ref)))) {
        add('モデル', 'warn', `${m.ref} は GGUF ではありません（先頭に印が無い。配布元の HTML の案内かも）`);
      }
      const big = tooBigForRam(m.sizeBytes, totalmem());
      if (big) add('モデル', 'warn', `${m.ref}: ${big}`);
    }
  }
} else if (runtime.id === 'ollama') {
  // 動かす土台は選べる。ここで片方しか案内しないと、必須のように見えてしまう。
  // 並べる順は「増える実行ファイルが少ない順」。何も入れられない機械が
  // いちばん困るので、そこで動くものを先に出す。
  add('モデル', 'bad', 'モデルを動かす土台がまだありません',
    'どれか一つを選んでください。\n'
    + '\n'
    + '  A. この中で読む（実行ファイルは増えません）\n'
    + '     GGUF を1つ置いて、画面の 設定 → モデル で「この中で読む」を選ぶだけ。\n'
    + '     設定ファイルに直接書くなら:\n'
    + '       "runtime": { "kind": "inproc", "modelsDir": "GGUF を置いた場所" }\n'
    + '     何も入れられない機械（会社の PC など）では、これだけが道になります。\n'
    + '\n'
    + '  B. Ollama（手早い。別に立てたものへ繋ぐ）\n'
    + '     https://ollama.com から入れて `ollama serve`\n'
    + '     そのあと `npm run models -- --get`（まず動く軽いものが入ります）\n'
    + '     一覧は `npm run models -- --available`。名前を直接渡すこともできます\n'
    + '\n'
    + '  C. llama.cpp（速い。実行ファイルが1つ増えます）\n'
    + '     `npm run llama` で llama-server をこちらが用意します。\n'
    + '       "runtime": { "kind": "llamacpp", "modelsDir": "GGUF を置いた場所" }\n'
    + '     オフロードの計算は GGUF を直接読んで行います（docs/GGUF.md）。');
} else {
  const dir = config.runtime?.modelsDir ?? defaultModelsDir();
  add('モデル', 'bad', `${dir} に GGUF がありません`,
    (runtime.id === 'inproc'
      ? 'この置き場に .gguf を1つ入れるだけで動きます。取ってくる先の例:\n'
        + '  https://huggingface.co/Qwen （名前に GGUF が付いたもの）\n'
        + '  迷ったら 3B の Q4_K_M（約2GB）。要約や下書きなら足ります。\n'
      : '')
    + '`npm run models -- --get` で取ってきます（まず動く軽いものが入ります）。\n'
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

/* ---------- モデルを読むライブラリ ---------- */

// この中で読む道は、ライブラリが要る。配布物には入っているが、
// 作業コピーには入っていない。**動かす直前まで分からない**のが困るので、
// ここで先に言う。
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

if (runtime.id === 'inproc') {
  const { stat } = await import('node:fs/promises');
  const here = join(installRoot(), 'node_modules', 'node-llama-cpp');
  const installed = await stat(here).then(() => true, () => false);
  const binPkg = `@node-llama-cpp/${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  let lib: { getLlama: (o?: { build?: 'never'; logLevel?: 'error' }) => Promise<unknown> } | undefined;
  try {
    lib = await import('node-llama-cpp') as typeof lib;
  } catch (e) {
    // 「入っていない」と「在るのに読み込めない」は別の話。後者を前者の顔で
    // 言うと、配布物の欠けに気づけない（実際に、そう配った）。
    add('モデルを読むもの', 'bad',
      installed
        ? 'node-llama-cpp は在るのに読み込めません（欠けています）'
        : 'node-llama-cpp が入っていません',
      (installed
        ? '配布物なら組み立てが壊れています。作業コピーなら入れ直してください:\n'
        : '配布物には入っています。作業コピーで使うときは:\n')
      + '  npm install --no-save --omit=optional --ignore-scripts node-llama-cpp\n'
      + `詳しくは docs/LOCAL-MODEL.md（${(e as Error).message.slice(0, 80)}）`);
  }
  if (lib) {
    try {
      // 組み立てに走らせない。無いなら無いと、すぐ言わせる。
      await quietly(() => lib.getLlama({ build: 'never', logLevel: 'error' }));
      add('モデルを読むもの', 'ok', 'node-llama-cpp（この機械むけの binary が動きます。実行ファイルは増えません）');
    } catch (e) {
      // 本体は読めるが、この機械むけの binary が無い。配る先（Windows）には
      // 入っているので、ここで「動かない」と数えると開発中も CI も
      // 直しようのない未了を抱え続ける。**警告**に留める。
      add('モデルを読むもの', 'warn',
        'node-llama-cpp はあるが、この機械むけの binary がありません',
        `${process.platform}-${process.arch} の分を入れてください:\n`
        + `  npm install --no-save --omit=optional --ignore-scripts ${binPkg}\n`
        + `詳しくは docs/LOCAL-MODEL.md（${(e as Error).message.slice(0, 80)}）`);
    }
  }
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
  // この中で読む道では、口はこのプログラムの中に立つ。**外から見に行っても
  // 意味がない**（モデルを読むまで立たないので、必ず「繋がりません」になる）。
  if (runtime.id === 'inproc' && p.locality === 'local') {
    // 札は設定の id（多くは "ollama"）だが、繋ぐ先は Ollama ではない。
    // 「接続 (ollama)」と出ると、Ollama を入れなければと読まれる。
    add('接続 (この中で読む)', 'ok', `${p.baseUrl}（この中に立てます。別に用意するものはありません）`);
    continue;
  }
  try {
    const res = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    add(label, res.ok ? 'ok' : 'warn', `${p.baseUrl} — HTTP ${res.status}`);
  } catch (e) {
    // **使っていないものが繋がらないのは、不足ではない。**
    // inproc / llamacpp を選んでいるなら Ollama は使わないので、
    // 未了として数えると「かたづける件数」が嘘になる。
    const unused = p.id === 'ollama' && runtime.id !== 'ollama';
    add(label, unused ? 'warn' : 'bad',
      `${p.baseUrl} に繋がりません${unused ? '（使っていません）' : ''}`,
      p.id === 'ollama'
        ? (unused
          ? `いまは ${runtime.id} で動かす設定なので、繋がらなくて構いません。\n`
            + '黙らせたいときは、aas.config.json の providers から ollama を消すか '
            + 'enabled: false にしてください。'
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
