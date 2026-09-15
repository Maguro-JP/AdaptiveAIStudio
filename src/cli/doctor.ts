/**
 * aas doctor — いま何が足りていないかを、一枚で出す。
 *
 * 「入れて、動かす」までの間に詰まる箇所は決まっている。
 * その都度こちらに訊かないと分からない、という状態にしない。
 *
 * 大事なのは、駄目出しで終わらせないこと。
 * 足りないものには**次に打つ一手**を必ず添える。
 */
import { loadConfig, ConfigBroken, enabledProviders, configPath } from '../config.ts';
import { MachineCache, describeMachine } from '../runtime/machine.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { resolveCounting } from '../core/counting.ts';
import { modelsDirNote, programDirNote } from './doctor-paths.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { formatChecks, summaryLine, type Check, type Level } from './doctor-view.ts';
import { inspectEnvironment, describeDriver } from '../runtime/environment.ts';
import { defaultModelsDir } from '../runtime/model-install.ts';
import { currentVersion, describeVersion } from '../core/version.ts';
import { installRoot, isPortable, productRoot, defaultWorkRoot, aasHome, asciiModelsDir } from '../core/home.ts';
import { how } from './how.ts';
import { canRun } from '../core/which.ts';
import { saveReport, tellWhereItWent } from './report-file.ts';
import { deepestUnder, judgeRoom, WINDOWS_MAX_PATH } from '../core/pathroom.ts';
import { resolve } from 'node:path';
import { probeBackend, describeBackend, GPU_NEEDS, type Backend, type LlamaLib } from '../runtime/inproc.ts';
const LLAMA_LIB = 'node-llama-cpp'; // 型検査に解決させない（src/runtime/inproc.ts 参照）

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

/*
 * **いま何を見ているかを、その場で出す。**
 *
 * ここは全部の行を溜めてから、最後に一度だけ表を出していた。**途中の一つが
 * 止まると、何も出ない。**画面には空行と入力待ちのカーソルだけが残り、
 * 動いているのか死んでいるのかも分からない。
 *
 * しかもこれは「困ったとき」に押すもので、**押す人はもう困っている。**
 * そこで無反応になるのがいちばん悪い。
 *
 * 実際に、配った先（Windows・OneDrive の下）で、押しても何も出ない形に
 * なった。溜める前に、これから見るものを一行ずつ出す。
 */
const step = (what: string): void => {
  process.stdout.write(c.dim(`  … ${what}\n`));
};

/* ---------- 実行環境 ---------- */

// **最初の一行を、いちばん先に出す。**押した人が「動いている」と分かる。
console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — doctor\n'));

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 6);
// 版を最初に出す。**貼ってもらった検査結果が、どの版のものか分からないと、
// 直したはずのものが直っていないように見える。**実際に一度そうなった。
add('版', 'ok', describeVersion(await currentVersion()));
add('Node.js', nodeOk ? 'ok' : 'bad', `v${process.versions.node}`,
  nodeOk ? undefined
    : 'v22.6 以降が要ります（型を剥がしながら実行する機能を使うため）。https://nodejs.org から入れ直してください。');

/* ---------- 設定 ---------- */

step('設定を読みます');


/*
 * **ここで死なない。**設定が壊れていると `loadConfig` は投げる。doctor は
 * 困ったときに見るものなので、ここで Node のスタックを出して終わると、
 * **何が起きているかを見に来た人が、何も見られずに終わる。**
 * 壊れていることを一行で言って、そこで止める（続けても、以降の行は
 * 全部でたらめになる）。
 */
let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigBroken)) throw e;
  console.log(c.red(e.message));
  process.exit(1);
}
const { config, source } = loaded;
add('設定', 'ok', source,
  source.includes('なし')
    ? `既定のまま動きます（この中で読む）。変えるなら画面の「設定」から。ファイルで書くなら ${configPath()}`
    : undefined);

/* ---------- 機械 ---------- */

step('この機械を調べます');

const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
add('この機械', 'ok', describeMachine(machine));

// GPU が見えていても、ドライバ側が通っていなければ CUDA は使えない。
if (machine.vramBytes > 0) {
  const driver = await describeDriver();
  if (driver) add('GPU ドライバ', 'ok', driver);
}

/* ---------- モデルの置き場 ---------- */

step('モデルを数えます');

const runtime = await buildRuntime(config, machine);
let models: Awaited<ReturnType<typeof runtime.list>> = [];
try {
  models = await runtime.list();
} catch (e) {
  add('モデル', 'bad', `一覧を取れません: ${(e as Error).message}`);
}

// モデルのフォルダが同期フォルダの中なら、遅い理由はモデルではなくそこかもしれない。
// GGUF がまだ無くても言う。置く前に分かるほうがよい。
if (runtime.id === 'inproc') {
  const synced = modelsDirNote(config.runtime?.modelsDir ?? defaultModelsDir());
  if (synced) add('モデルのフォルダ', 'warn', synced.text, synced.hint);
}

if (models.length > 0) {
  add('モデル', 'ok', `${models.length} 件: ${models.slice(0, 3).map((m) => m.ref).join(', ')}`
    + (models.length > 3 ? ' …' : ''));
  /*
   * **どれを読むのかを、送る前に出す。**ただし、**読む側の backend が分かってから**
   * （下の「モデルを読むもの」の後、`whichModel`）。
   *
   * ここは何件あるかしか出していなかった。選ぶのは送ったときで、選び方は
   * 見えない。GPU の無い機械で大きい方を掴むと、最初の送信で何分も待つ
   * ことになるのに、その前に分かる手がかりがどこにも無かった。
   *
   * 次に、nvidia-smi に見える GPU で決めていた。読む側は CPU で回っているのに
   * 「GPU があるので大きい方」と言い、その通りに大きい方を掴んで答えなかった（実機）。
   */
  // 名前だけ .gguf の別物と、記憶に載らないものは、ここで言う。
  // 送ってから 503 を見るより、貼る出力で先に分かるほうが早い。
  if (runtime.id === 'inproc') {
    const { looksLikeGguf, tooBigForRam } = await import('../runtime/inproc.ts');
    const { totalmem } = await import('node:os');
    const dir = config.runtime?.modelsDir ?? defaultModelsDir();
    let usable = 0;
    for (const m of models) {
      if (await looksLikeGguf(join(dir, m.ref))) usable += 1;
      else add('モデル', 'warn', `${m.ref} は GGUF ではありません（先頭に印が無い。配布元の HTML の案内かも）`);
      const big = tooBigForRam(m.sizeBytes, totalmem());
      if (big) add('モデル', 'warn', `${m.ref}: ${big}`);
    }
    /*
     * **一つも読めないなら「動かせます」と言わない。**
     *
     * 一件ずつは 注意 で出していたが、締めの一行は 未了（bad）の数だけを
     * 見る。だから全部読めなくても「動かせます」と出ていた。実際に送ると
     * 503 で断られる。**立ち上がることを、使えることとして言っていた。**
     * 置いてある数ではなく、**使える数**で決める。
     */
    if (usable === 0) {
      add('モデル', 'bad',
        `${models.length} 件ありますが、どれも GGUF として読めません`,
        '配布元の同意頁の HTML を落とした形が多いです。ブラウザで開き直して、'
        + `本物を ${dir} へ置いてください。`);
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
    + `     そのあと \`${how('models', '--get')}\`（まず動く軽いものが入ります）\n`
    + `     一覧は \`${how('models', '--available')}\`。名前を直接渡すこともできます\n`
    + '\n'
    + '  C. llama.cpp（速い。実行ファイルが1つ増えます）\n'
    + `     \`${how('llama')}\` で llama-server をこちらが用意します。\n`
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
    // portable には npm が無い。無いものを打てと言わない。画面から取れる。
    + (isPortable()
      ? '画面（AdaptiveAIStudio.cmd）の 設定 → モデル から取ってこられます（まず動く軽いものが入ります）。\n'
      : `\`${how('models', '--get')}\` で取ってきます（まず動く軽いものが入ります）。\n`
        + `一覧は \`${how('models', '--available')}\`。\n`)
    + '手持ちがあるなら、同じ置き場に .gguf を入れるだけでも使えます。\n'
    + `いまの置き場: ${config.runtime?.modelsDir ?? `${defaultModelsDir()}（既定）`}`);
}

/*
 * **黙って別の場所へ置かない。**
 *
 * 利用者名が全角だと、根も全角になる。llama.cpp は全角の混ざった道から
 * モデルを開けないので、**モデルだけ** `%ProgramData%` へ逃がしている
 * （`src/core/home.ts` の `asciiModelsDir`）。
 *
 * 逃がしていること自体は、どこにも出ていなかった。使う側から見ると
 * **モデルだけ、置いたはずの場所と違う所に居る。**理由が分からないまま
 * 「なぜここに置かれるのか」を探すことになる。逃がしたなら、そう言う。
 */
const escaped = asciiModelsDir(aasHome());
if (escaped) {
  add('モデルの保存先', 'ok', `${escaped}（逃がしています）`,
    `いまの根（${aasHome()}）に全角が混ざっています。`
    + 'モデルを読むところが、全角の混ざった道からファイルを開けません。'
    + 'モデルだけ ProgramData へ逃がしています（半角で、管理者権限も要りません）。'
    + '設定と記録は根のままです。');
}

/* ---------- llama-server ---------- */

step('llama-server を探します');

// 借り物ではなく自前で持てているか。ここが空だと、
// 誰かが入れたものに相乗りしている状態になる。
const llamaPath = await findInstalled();
if (llamaPath) {
  add('llama-server', 'ok', llamaPath);
} else if (config.runtime?.kind === 'llamacpp') {
  add('llama-server', 'bad', 'まだ用意していません',
    `\`${how('llama')}\` で取ってきます。\n`
    + 'いまは PATH にある llama-server を探しますが、'
    + 'それは他の道具（LM Studio など）が入れたもので、消されると動かなくなります。');
}
// runtime.kind が llamacpp でなく、用意もしていない場合は何も言わない。
// 使っていないものが足りないのは、問題ではない。

/* ---------- モデルを読むライブラリ ---------- */

step('モデルを読むものを確かめます（初回は少し待ちます）');

// この中で読む道は、ライブラリが要る。bundle には入っているが、
// 作業コピーには入っていない。**動かす直前まで分からない**のが困るので、
// ここで先に言う。
/*
 * 向こうの console.warn（「A prebuilt binary was not found」など）は
 * `probeBackend` が黙らせて拾い、こちらの一行にする。ここでは触らない。
 */
/*
 * 長くかかっているものを、**かかっている最中に言う。**
 *
 * ここは返ってくるまで何も出ない。手元では一瞬で返るが、繋がっていない
 * ドライブや、必要になるまで実体を持たない置き方では何十秒もかかる。
 * その間、押した人には止まったようにしか見えない。
 *
 * 待つのはやめない（読み込みを途中で切ると、結果が嘘になる）。
 * **かかっていることだけを出す。**
 */
async function saying<T>(what: string, run: () => Promise<T>): Promise<T> {
  const began = Date.now();
  const timer = setInterval(() => {
    process.stdout.write(c.dim(`  … ${what}（${Math.round((Date.now() - began) / 1000)} 秒）\n`));
  }, 10_000);
  timer.unref?.();
  try { return await run(); } finally { clearInterval(timer); }
}

{
  // プログラムのフォルダも見る。OneDrive の中だと、立ち上がりが遅い理由がそこにある。
  const synced = programDirNote(installRoot());
  if (synced) add('プログラムのフォルダ', 'warn', synced.text, synced.hint);
}

/** 読む側が実際に使う backend。ライブラリを起こせたときだけ分かる。 */
let backend: Backend | undefined;

/**
 * どれを読むか。**backend が分かってから**言う。分からなければ nvidia-smi の結果で代える
 * （そのときは、画面と同じ選び方）。
 */
const whichModel = async () => {
  if (runtime.id !== 'inproc' || models.length <= 1) return;
  const { chooseModel, CHOICE_WHY } = await import('../runtime/inproc.ts');
  const { totalmem: ram } = await import('node:os');
  const hasGpu = backend ? backend.gpu !== false : machine.gpuName !== undefined;
  const picked = chooseModel(models, ram(), config.runtime?.model, {
    hasGpu, ...(backend?.vramBytes ? { vramBytes: backend.vramBytes } : {}),
  });
  if (!picked) return;
  add('読むモデル', 'ok', `${picked.chosen.ref}（${CHOICE_WHY[picked.why]}）`,
    config.runtime?.model ? undefined : '別のものを使うなら 設定 → モデル で選べます。');
};

if (runtime.id === 'inproc') {
  const { stat } = await import('node:fs/promises');
  const here = join(installRoot(), 'node_modules', 'node-llama-cpp');
  const installed = await stat(here).then(() => true, () => false);
  const binPkg = `@node-llama-cpp/${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  let lib: LlamaLib | undefined;
  try {
    lib = await saying('まだ読んでいます', () => import(LLAMA_LIB)) as typeof lib;
  } catch (e) {
    // 「入っていない」と「在るのに読み込めない」は別の話。後者を前者の顔で
    // 言うと、bundle の欠けに気づけない（実際に、そう配った）。
    add('モデルを読むもの', 'bad',
      installed
        ? 'node-llama-cpp は在るのに読み込めません（欠けています）'
        : 'node-llama-cpp が入っていません',
      (isPortable()
        ? '中身が壊れています。落とし直してください:\n'
          + '  https://github.com/Maguro-JP/AdaptiveAIStudio/releases\n'
        : (installed
          ? '作業コピーなら入れ直してください:\n'
          : 'setup.exe や portable には入っています。作業コピーで使うときは:\n')
          + '  npm install --no-save --omit=optional --ignore-scripts node-llama-cpp\n')
      + `詳しくは docs/LOCAL-MODEL.md（${(e as Error).message.slice(0, 80)}）`);
  }
  if (lib) {
    try {
      // 組み立てに走らせない。無いなら無いと、すぐ言わせる。
      const probed = await saying('この機械むけの binary を調べています',
        () => probeBackend(lib, config.runtime?.gpu ?? 'auto', { gpuSeen: machine.gpuName !== undefined }));
      backend = probed.backend;
      /*
       * **GPU が見えているのに CPU で読む**は、動くことは動くが、答えるまで何分も
       * かかり、記憶も使い切る。「動きます」で済ませない。何で読むかを、ここで言う。
       */
      const line = describeBackend(backend);
      if (!backend.gpu && machine.gpuName) {
        add('モデルを読むもの', 'warn', `node-llama-cpp。${line}`,
          `GPU（${machine.gpuName}）は見えていますが、読む側が使えていません。\n`
          + (backend.reason === 'no-binary'
            ? 'この配布物に GPU 用の binary（@node-llama-cpp/win-x64-cuda・win-x64-vulkan）が入っていません。'
              + '新しいものを落とし直してください。\n'
            : backend.reason === 'load-failed'
              ? 'NVIDIA のドライバを新しくしてから、もう一度試してください。\n'
              : backend.reason === 'off'
                ? '設定 runtime.gpu が off です。auto にすると使います。\n'
                : `読む側が GPU を探し当てられませんでした。${GPU_NEEDS}\n`
                  + 'NVIDIA のドライバを入れ直すと、Vulkan の分は揃うことが多いです。\n')
          + 'CPU でも動きますが、最初の答えまで何分もかかります。');
      } else {
        add('モデルを読むもの', 'ok', `node-llama-cpp。${line}。実行ファイルは増えません`);
      }
      /*
       * どう数えているか。
       *
       * 窓に何を残して何を落とすかは、全部この数え方の上に立っている。
       * 本物なのか見積もりなのかが見えないと、切れ方がおかしいときに
       * 「モデルが悪い」としか言えない。
       */
      const how = await resolveCounting(config).catch(() => undefined);
      if (how) {
        add('トークンの数え方', how.counter ? 'ok' : 'warn', how.why,
          how.counter ? undefined
            : '見積もりでも動きますが、日本語で外しやすく、外した分だけ切る位置がずれます。');
      }
    } catch (e) {
      // 本体は読めるが、この機械むけの binary が無い。配る先（Windows）には
      // 入っているので、ここで「動かない」と数えると開発中も CI も
      // 直しようのない未了を抱え続ける。**警告**に留める。
      add('モデルを読むもの', 'warn',
        'node-llama-cpp はあるが、この機械むけの binary がありません',
        // bundle には npm が無い。入れろと言っても打てない。
        // 配るのは win-x64 むけなので、別の機械で開いたときにここへ来る。
        (isPortable()
          ? `このbundle は別の機械むけです（いまの機械: ${process.platform}-${process.arch}）。\n`
            + 'その機械むけに組み直したものが要ります。\n'
          : `${process.platform}-${process.arch} の分を入れてください:\n`
            + `  npm install --no-save --omit=optional --ignore-scripts ${binPkg}\n`)
        + `詳しくは docs/LOCAL-MODEL.md（${(e as Error).message.slice(0, 80)}）`);
    }
  }
}
await whichModel();

/* ---------- 置き場所の深さ ---------- */

step('道の深さを測ります');

// Windows だけの話。道の全体が 260 文字を超えると開けない。
// **展開の時点で当たる**ので、こちらが動いていれば既に通っている。
// それでも言うのは、いま何文字余っているかが分かれば、モデルを置く前に
// 直せるため（モデルの名前は長い）。利用者の機械で実際に警告が出た。
if (process.platform === 'win32') {
  const where = isPortable() ? productRoot() : installRoot();
  const deep = await deepestUnder(where);
  const { level, room } = judgeRoom(where.length, deep.length);
  const detail = `${where}（あと ${room} 文字）`;
  if (level === 'bad') {
    add('置き場所の深さ', 'bad', detail,
      `Windows の上限（${WINDOWS_MAX_PATH} 文字）を ${-room} 文字超えています。\n`
      + 'このフォルダごと、短い所へ移してください（例: Z:\\AdaptiveAIStudio）。\n'
      + `いちばん深いもの: ${deep.rel}`);
  } else if (level === 'warn') {
    add('置き場所の深さ', 'warn', detail,
      'モデル（.gguf）は名前が長いので、このままだと置けないことがあります。\n'
      + 'このフォルダごと、短い所へ移すと直ります（例: Z:\\AdaptiveAIStudio）。');
  } else {
    add('置き場所の深さ', 'ok', detail);
  }
}

/* ---------- 外の道具（MCP） ---------- */

step('外のツールを見ます');

// 繋がらない理由でいちばん多いのは、合言葉が無いこと。**値は出さない。**
// 名前が環境にあるか（data/.env から読めたか）だけを言う。
{
  const servers = Object.entries(config.mcp?.servers ?? {});
  if (servers.length === 0) {
    add('外の道具', 'ok', '繋いでいません（設定の mcp.servers に足せます。GitHub もここ）');
  }
  for (const [name, spec] of servers) {
    if (spec.enabled === false) {
      add(`外の道具 (${name})`, 'ok', '設定はあるが enabled: false（使うなら true に）');
      continue;
    }
    // 遠くに繋ぐものは、立ち上げるものが無い。ここで見るのは手元のものだけ。
    if (spec.url) {
      add(`外の道具 (${name})`, 'ok', `遠くに繋ぎます: ${spec.url}`);
      continue;
    }
    if (!spec.command) {
      add(`外の道具 (${name})`, 'warn', '立ち上げるものも、繋ぎ先も書かれていません',
        'command か url のどちらかが要ります。');
      continue;
    }
    // 立ち上げる前に、その命令が在るかを見る。bundle には npm も npx も
    // 入っていないので、設定に書けても動かない。**書いたのに何も起きない**を止める。
    if (!canRun(spec.command)) {
      add(`外の道具 (${name})`, 'warn', `その命令がありません: ${spec.command}`,
        spec.command === 'npx' || spec.command === 'npm'
          ? 'bundle には node だけが入っています（npm と npx は入っていません）。\n'
            + 'この道具は、Node と npm が入っている機械で使ってください。'
          : 'PATH に無いか、名前が違います。道（フォルダ）から書くこともできます。');
      continue;
    }
    const wants = Object.entries(spec.envFrom ?? {});
    const missing = wants.filter(([, from]) => process.env[from] === undefined).map(([, from]) => from);
    if (missing.length > 0) {
      add(`外の道具 (${name})`, 'warn', `合言葉が環境にありません: ${missing.join(', ')}`,
        `置き場の .env に一行ずつ置いてください（例: ${missing[0]}=…）。値は設定ファイルに書きません。`);
    } else {
      add(`外の道具 (${name})`, 'ok', `${spec.command} ${(spec.args ?? []).join(' ')}`.trim()
        + (wants.length > 0 ? `（合言葉 ${wants.map(([, f]) => f).join(', ')} あり）` : ''));
    }
  }
}

/* ---------- 繋ぎ先 ---------- */

step('繋ぎ先を見ます');

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

step('外側の詰まりを見ます');

/*
 * こちらの作りが正しくても、モデルを動かす層が詰まっていたら何も動かない。
 * 「うちは悪くない」で終わらせず、外側も見に行く。
 */
const envIssues = await inspectEnvironment({
  stateDir: stateDir(),
  root: resolve(config.agent?.root ?? defaultWorkRoot()),
  // 未設定でも既定の置き場を渡す。設定した人だけが検査されるのでは逆で、
  // 既定のまま使っている人こそ、全角のユーザー名で詰まる。
  modelsDir: config.runtime?.modelsDir ?? defaultModelsDir(),
  hasGpu: machine.vramBytes > 0,
});
for (const issue of envIssues) {
  add(issue.title, issue.level, issue.detail, issue.fix);
}

/* ---------- 保存先 ---------- */

step('保存先を確かめます');

try {
  const files = await readdir(stateDir());
  add('記録の置き場', 'ok', `${stateDir()}（${files.length} 件）`);
} catch {
  add('記録の置き場', 'ok', `${stateDir()}（まだ空。初回起動で作られます）`);
}

/*
 * **そこへ書けるかを、実際に書いて確かめる。**
 *
 * ここは「在るか」しか見ていなかった。読めるだけの場所（読み取り専用で
 * 配られたフォルダ、権限の足りない `%ProgramData%`、会社のクラウド
 * ドライブ）でも ok と出る。**会話も、戻り先も、設定も、何ひとつ残らない
 * のに、こちらは緑を出す。**気づくのは、閉じて開き直して全部消えたとき。
 *
 * 権限の形は機械ごとに違うので、読んで判断しない。一度書いて、消す。
 */
{
  const { writeFile, unlink, mkdir: mkdirp } = await import('node:fs/promises');
  const probe = join(stateDir(), '.write-probe');
  try {
    await mkdirp(stateDir(), { recursive: true });
    await writeFile(probe, 'x');
    await unlink(probe);
    add('書き込み', 'ok', `${stateDir()} へ書けます`);
  } catch (e) {
    add('書き込み', 'bad', `${stateDir()} へ書けません（${(e as Error).message}）`,
      '会話も、戻り先も、設定も残りません。書ける場所を AAS_HOME に指し直すか、'
      + 'そのフォルダの権限を直してください。');
  }
}

/* ---------- 出す ---------- */

console.log('');

const style = {
  mark: { ok: c.green('  ok  '), warn: c.yellow(' 注意 '), bad: c.red(' 未了 ') },
  markWidth: 6,
  dim: c.dim,
  hint: c.yellow,
  good: c.green,
};

for (const line of formatChecks(checks, style)) console.log(line);
console.log();
// 締めの一手も、この場所で打てる形で言う。
console.log(summaryLine(checks, style, isPortable()
  ? { ui: 'AdaptiveAIStudio.cmd' }
  : { ui: how('ui'), agent: how('agent') }));
console.log();

/*
 * **同じものを、ファイルにも残す。**
 *
 * ここは画面に出して終わりだった。開発は Linux、使うのは Windows なので、
 * こちらで確かめられないことは必ず残る。そこまでは仕方がない。
 *
 * 仕方がなくないのは、**その先を利用者の手作業にしていた**こと。
 * cmd の画面から文字を拾うのは Windows ではとても面倒で（右クリック→範囲
 * 選択→Enter、途中で切れる）、結局「試す係をやってください」と同じになる。
 *
 * 押した場所の隣に置く。**探させない。**そこへ書けないとき
 * （Program Files に入れた形）だけ、記録の保存先へ逃がす。
 */
const flat = [
  'AdaptiveAIStudio — doctor',
  '',
  ...formatChecks(checks, {
    mark: { ok: '  ok  ', warn: ' 注意 ', bad: ' 未了 ' },
    markWidth: 6,
    dim: (t: string) => t, hint: (t: string) => t, good: (t: string) => t,
  }),
].join('\n');
for (const line of tellWhereItWent(
  /*
   * **記録の置き場へ置く。プログラムの隣へ撒かない。**
   * ここは productRoot() が先だったので、git のクローンから回すと
   * リポジトリの根に doctor-*.txt が溜まった（実機の画面で 18 件、手元で 37 件）。
   * 押すたびに増えるものを、利用者が毎日見るフォルダに置かない。
   */
  await saveReport('doctor', flat, [join(stateDir(), 'reports'), stateDir(), productRoot()]),
)) console.log(`  ${line}`);
console.log();
