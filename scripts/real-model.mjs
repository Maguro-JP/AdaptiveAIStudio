/**
 * 本物のモデルで、中で読む道を通す。
 *
 * **ここまで、中で読む道は一度も本物で動かしていなかった。**
 * 差し替えの試験は通っていたが、それは「差し替えが動く」ことしか言っていない。
 *
 * 網の外からモデルを取ってこられない場所でも確かめられるよう、
 * 最小の GGUF を自分で組んで使う（中身は無意味。乱数の重み）。
 * 見るのは、読める・文脈が作れる・文字が返る・窓を読む、の四つ。
 *
 * node-llama-cpp が無い場所では飛ばす（bundle には入っていない）。
 */
import { PRIORITY_HEADER, Priority } from '../src/providers/contract.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  await import('node-llama-cpp');
} catch {
  console.log('飛ばします: node-llama-cpp が入っていません');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'aas-real-'));
const model = join(dir, 'tiny.gguf');
execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), model], { stdio: 'pipe' });

const { InProcRuntime } = await import(join(root, 'src', 'runtime', 'inproc.ts'));
const logs = [];
const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => logs.push(l) });

const bad = [];
try {
  const { baseUrl } = await rt.ensureLoaded('tiny.gguf');

  // 1. コンテキストウィンドウは、ファイルに書いてあるぶんを使っているか。
  if (!logs.some((l) => l.includes('コンテキストウィンドウ: 2048'))) {
    bad.push(`コンテキストウィンドウを読んでいない: ${logs.join(' / ')}`);
  }

  // 2. 一往復（まとめて返す道）。
  const once = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const body = await once.json();
  const said = body?.choices?.[0]?.message?.content;
  if (typeof said !== 'string') bad.push(`まとめて返す道で返事が無い: ${JSON.stringify(body).slice(0, 200)}`);

  // 3. 流して返す道。
  const streamed = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: true, max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const raw = await streamed.text();
  if (!raw.includes('data: ')) bad.push('流して返す道が SSE になっていない');
  if (!raw.includes('[DONE]')) bad.push('流して返す道が終わっていない');

  // 4. 型が分かるか（分からないなら、道具は本文で渡す道に落ちる）。
  const wrappers = rt.wrappers();
  if (wrappers.length !== 1) bad.push(`読み込んだモデルが数えられていない: ${JSON.stringify(wrappers)}`);
  const guessed = wrappers[0]?.guessed === true;

  // 5. 道具を渡したときに、道が選ばれているか。
  //
  //    型が当てずっぽうなら、**本文で渡す道**に落ちるはず。
  //    そこが繋がっていないと、道具は一度も呼ばれない（画面からは
  //    「動いているが何もしない」に見える）。本物で踏んでおく。
  const withTools = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'ファイルを読む',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    }),
  });
  if (!withTools.ok) {
    bad.push(`道具を渡すと落ちる: ${withTools.status} ${(await withTools.text()).slice(0, 200)}`);
  } else {
    const got = await withTools.json();
    const choice = got?.choices?.[0];
    if (!choice) bad.push(`道具を渡したときに返事が無い: ${JSON.stringify(got).slice(0, 200)}`);
    // 乱数の重みなので、呼び出しは出ない。**落ちないこと**と、
    // 生の JSON を人に見せていないことを見る。
    else if (typeof choice.message?.content !== 'string') {
      bad.push(`返事の形が違う: ${JSON.stringify(choice).slice(0, 200)}`);
    } else if (/tool_call|"arguments"/.test(choice.message.content)) {
      bad.push(`生の呼び出しが本文に出ている: ${choice.message.content.slice(0, 120)}`);
    }
  }
  if (!guessed) {
    console.log('（この模型の型は当てずっぽうではありませんでした。本文で渡す道は踏んでいません）');
  }

  /*
   * 6. **モデル同梱の話し方（chat_template）を持つ形。**
   *
   *    本物のモデルはこれを持っている。持っていると型が決まり
   *    （当てずっぽうではなくなり）、道具は**本文ではなく素の道**で渡る。
   *    つまりここまで踏んでいたのは**偽物でだけ通る道**だった。
   *    本物で最初に通るのはこちらなので、ここも踏んでおく。
   */
  const tplDir = mkdtempSync(join(tmpdir(), 'aas-real-tpl-'));
  const tplLogs = [];
  const tplRt = new (await import(join(root, 'src', 'runtime', 'inproc.ts'))).InProcRuntime(
    { modelsDir: tplDir, port: 0, onLog: (l) => tplLogs.push(l) },
  );
  try {
    execFileSync(
      process.execPath,
      [join(root, 'scripts', 'tiny-gguf.mjs'), join(tplDir, 'tpl.gguf'), '--chat-template'],
      { stdio: 'pipe' },
    );
    const { baseUrl: tplUrl } = await tplRt.ensureLoaded('tpl.gguf');
    const how = tplRt.wrappers().find((w) => w.ref === 'tpl.gguf');
    if (!how) bad.push('話し方の型が分からない');
    else if (how.guessed) {
      bad.push(`同梱の話し方を使っていない（${how.wrapper} で当てずっぽうのまま）`);
    }
    const r = await fetch(`${tplUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tpl.gguf', stream: false, max_tokens: 8,
        messages: [{ role: 'user', content: 'read a.ts' }],
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            description: 'ファイルを読む',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        }],
      }),
    });
    if (!r.ok) bad.push(`同梱の話し方で道具を渡すと落ちる: ${r.status} ${(await r.text()).slice(0, 200)}`);
    else {
      const got = await r.json();
      const msg = got?.choices?.[0]?.message;
      if (typeof msg?.content !== 'string') {
        bad.push(`同梱の話し方で返事の形が違う: ${JSON.stringify(got).slice(0, 200)}`);
      } else if (/tool_call|"arguments"/.test(msg.content)) {
        bad.push(`同梱の話し方で生の呼び出しが本文に出ている: ${msg.content.slice(0, 120)}`);
      }
    }
  } finally {
    await tplRt.shutdown();
    rmSync(tplDir, { recursive: true, force: true });
  }
} catch (e) {
  bad.push(`落ちました: ${e.message}`);
} finally {
  await rt.shutdown();
  // **消す前に確かめる。**tiny.gguf はここで消える。
  bad.push(...await predictorKeepsOutput());
  rmSync(dir, { recursive: true, force: true });
}

/*
 * 会話の土台ごと、一往復。
 *
 * ここまでの実走は、相手を差し替えたものだった。**本物のモデルで、
 * 土台（決まり・学び・道具・刈り込み・判定）を通したことが一度も無い。**
 * 返る文字は無意味でよい。**落ちないこと**と、道が繋がっていることを見る。
 */
async function throughSession() {
  const { mkdtempSync, rmSync: rm } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'aas-real-home-'));
  const models = mkdtempSync(join(tmpdir(), 'aas-real-models-'));
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), join(models, 'tiny.gguf')], { stdio: 'pipe' });
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');

  const { UiServer } = await import(join(root, 'src', 'ui', 'server.ts'));
  const { DEFAULT_CONFIG } = await import(join(root, 'src', 'config.ts'));
  const work = mkdtempSync(join(tmpdir(), 'aas-real-work-'));

  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      runtime: { kind: 'inproc', modelsDir: models },
      agent: { root: work, approval: 'auto', maxTurns: 2, verify: { enabled: false } },
      initiative: { enabled: false },
    },
  });
  const base = (await server.start()).replace(/\/$/, '');
  const found = [];
  try {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'こんにちは' }),
    });
    if (r.status !== 202) found.push(`送れない: ${r.status} ${await r.text()}`);

    // 静かになるまで待つ（本物のモデルなので遅い）。
    // **出来事の流れで見る。**`/api/state` は動いているかどうかを返さないので、
    // それを当てにすると「待ったつもりで見ていない」ことになる。
    const ac = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = events.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let settled = false;
    const until = Date.now() + 180_000;
    while (Date.now() < until && !settled) {
      const step = await Promise.race([
        reader.read(),
        new Promise((res) => setTimeout(() => res({ value: undefined }), 2000)),
      ]);
      if (step.value) buf += dec.decode(step.value, { stream: true });
      settled = /"type":"busy","busy":false/.test(buf) || /"type":"settled"/.test(buf);
    }
    ac.abort();
    if (!settled) found.push('一往復が終わらない（180秒）');
    // **本物の数え方で数えていること。**繋がっていなければ、字句器は
    // 作っただけで何もしていない（見積もりのまま切られる）。
    const { Session } = await import(join(root, 'src', 'core', 'session.ts'));
    const { DEFAULT_CONFIG: DC } = await import(join(root, 'src', 'config.ts'));
    const probe = await Session.create({
      ...DC,
      runtime: { kind: 'inproc', modelsDir: models },
      agent: { root: work, approval: 'auto' },
      initiative: { enabled: false },
    }, { approve: () => Promise.resolve(true) });
    const how = await probe.counting();
    if (!how.counter) found.push(`本物の数え方に繋がっていない（${how.why}）`);

    // 学びが決まりに載っていること（土台を通っている証拠）。
    const state = await fetch(`${base}/api/state`).then((x) => x.json());
    const lessons = (state.memory ?? []).filter((m) => m.kind === 'displeasure');
    if (lessons.length === 0) found.push('二度としないことが入っていない（土台を通っていない）');
  } catch (e) {
    found.push(`落ちました: ${e.message}`);
  } finally {
    await server.stop().catch(() => undefined);
    rm(home, { recursive: true, force: true });
    rm(models, { recursive: true, force: true });
    rm(work, { recursive: true, force: true });
  }
  return found;
}

/**
 * 先読み（token predictor）を付けても、出てくるものが変わらないこと。
 *
 * 直しは、渡した中身をそのまま書き戻すことが多い（`edit_file`）。
 * 出てくるトークンの多くは入力に既に在るので、そこを当てにいくと
 * その分まとめて確かめられて速くなる。ライブラリも用途に
 * 「modifying code」を挙げている。
 *
 * **速くなることは、ここでは確かめられない**（当てが効くほどの中身を
 * 持たない模型なので）。確かめるのは**出力が変わらないこと**。
 * ここが変われば、速さのための工夫が答えを変えていることになる。
 */
async function predictorKeepsOutput() {
  const found = [];
  const lib = await import('node-llama-cpp');
  if (!lib.InputLookupTokenPredictor) return ['先読み（InputLookupTokenPredictor）が無い版です'];
  const llama = await lib.getLlama({ gpu: false, build: 'never', logLevel: 'error' });
  const loaded = await llama.loadModel({ modelPath: model });

  const say = async (withPredictor) => {
    const context = await loaded.createContext({ contextSize: 512 });
    const seq = context.getSequence(
      withPredictor ? { tokenPredictor: new lib.InputLookupTokenPredictor() } : undefined,
    );
    const session = new lib.LlamaChatSession({ contextSequence: seq });
    const out = await session.prompt(
      'export function add(a, b) { return a + b; } これを引き算にして',
      { temperature: 0, maxTokens: 48 },
    );
    const stats = seq.tokenPredictions;
    await context.dispose();
    return { out, stats };
  };

  const off = await say(false);
  const on = await say(true);
  if (off.out !== on.out) found.push('先読みを付けると出力が変わる（速さの工夫が答えを変えている）');
  // 当てにいってすらいないなら、繋がっていない。
  const tried = (on.stats?.validated ?? 0) + (on.stats?.refuted ?? 0);
  if (tried === 0) found.push(`先読みが働いていない: ${JSON.stringify(on.stats)}`);
  return found;
}

/*
 * 考えごと（<think>）をする模型で、実機の壊れ方と直し方を再現する。
 *
 * **ここが無いと、実機で 18 分止まる形を手元で一度も再現できない。**
 * 素の tiny.gguf は考えごとをしないので、Qwen3 が答える前に <think> を延々
 * 書いて本文 0 で「完了」になる形（0.11.2 が直した形）を確かめられなかった。
 *
 * 見るのは二つ:
 *   1. 予算をかけないと、本文が空で考えごとだけになる（＝壊れている形）。
 *      画面には onTextChunk が一度も来ないので、17 分「入力を読んでいます」に見える。
 *   2. inproc は予算 0（thoughtTokens: 0）を渡すので、考えごとが即閉じて
 *      本文が流れる（＝直っている形）。流して返す道で、content が来ることを見る。
 *
 * 本物の Qwen3 とはここだけ違う（本物はモデルが自分で <think> を出す。この
 * 模型は chat_template で頭から開ける）。**予算の効き方は同じ経路**なので、
 * 壊れ方と直し方はここで確かめられる。
 */
async function thinkingBudget() {
  const found = [];
  const dir = mkdtempSync(join(tmpdir(), 'aas-think-'));
  const at = join(dir, 'think.gguf');
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), at, '--thinks'], { stdio: 'pipe' });

  // 1. この模型が「考えごとをする」ことを、素のライブラリで確かめる。
  //    予算をかけないと、本文が空で考えごとだけになる。ここが崩れていたら、
  //    以下の「直った形」も意味を持たない（何も再現していないことになる）。
  const lib = await import('node-llama-cpp');
  const llama = await lib.getLlama({ gpu: false, build: 'never', logLevel: 'error' });
  const model = await llama.loadModel({ modelPath: at });
  try {
    const ctx = await model.createContext({ contextSize: 512 });
    const session = new lib.LlamaChatSession({ contextSequence: ctx.getSequence() });
    let textLen = 0;
    let thought = 0;
    await session.prompt('hi', {
      maxTokens: 24, temperature: 0,
      onResponseChunk: (c) => { if (c.type === 'segment' && c.segmentType === 'thought') thought += c.text.length; },
      onTextChunk: (t) => { textLen += t.length; },
    });
    if (!(textLen === 0 && thought > 0)) {
      found.push(`考えごとの模型になっていない（予算なしで 本文 ${textLen} 文字 / 考えごと ${thought} 文字）。`
        + '本文が空で考えごとだけ、を作れていないので、実機の壊れ方を再現できていない');
    }
    await ctx.dispose();
  } finally {
    await model.dispose?.();
  }

  // 2. inproc（予算 0）を通すと、流して返す道で content が来る。
  const rt = new InProcRuntime({ modelsDir: dir, port: 0 });
  try {
    const { baseUrl } = await rt.ensureLoaded('think.gguf');
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'think.gguf', stream: true, max_tokens: 24, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const raw = await r.text();
    // content の delta が一つでも来ていること。考えごとで埋まると、ここが空になる。
    const gotContent = raw.split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return undefined; } })
      .some((o) => typeof o?.choices?.[0]?.delta?.content === 'string' && o.choices[0].delta.content.length > 0);
    if (!gotContent) {
      found.push(`inproc が考えごとの模型で本文を流さない。予算 0（thoughtTokens: 0）が効いていない: ${raw.slice(0, 200)}`);
    }
  } finally {
    await rt.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  return found;
}

/*
 * **本物のライブラリで、二つの会話に同時に答える。**
 *
 * sequence を N 本取って、それぞれに LlamaChatSession を持たせる道が、
 * 本物の node-llama-cpp で通ることを見る。モックの試験（inproc-parallel）
 * では「並ぶ」ことは見たが、本物のライブラリが sequences:N と getSequence を
 * N 回受けて、二つ同時に評価するところは、ここでしか踏めない。
 *
 * tiny.gguf は諸元が読めるので、既定で 2 本持つ。二つ同時に投げて、
 * 両方に返事が流れて終わることを見る（乱数の重みなので中身は問わない）。
 */
async function throughParallel() {
  const found = [];
  const dir = mkdtempSync(join(tmpdir(), 'aas-par-'));
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), join(dir, 'tiny.gguf')], { stdio: 'pipe' });
  const logs = [];
  const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => logs.push(l) });
  try {
    const { baseUrl } = await rt.ensureLoaded('tiny.gguf');
    // 本物のライブラリが、本当に 2 本の sequence を取れたこと。
    if (!logs.some((l) => /並列 2 本/.test(l))) {
      found.push(`並列 2 本を持てていない: ${logs.filter((l) => l.includes('読み込みました')).join(' / ')}`);
    }
    // 二つの会話（最優先）。既定の中だと、上のために半分を空けるので並ばない。
    const ask = () => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', [PRIORITY_HEADER]: String(Priority.top) },
      body: JSON.stringify({ model: 'tiny.gguf', stream: true, max_tokens: 12, messages: [{ role: 'user', content: 'hi' }] }),
    }).then((r) => r.text());
    const [a, b] = await Promise.all([ask(), ask()]);
    for (const [who, raw] of [['一つ目', a], ['二つ目', b]]) {
      if (!raw.includes('data: ')) found.push(`${who}が SSE になっていない`);
      if (!raw.includes('[DONE]')) found.push(`${who}が終わっていない`);
    }
  } catch (e) {
    found.push(`落ちました: ${e.message}`);
  } finally {
    await rt.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  return found;
}


/**
 * 端末の入口（agent / chat / team）が、保存先の GGUF に辿り着くこと。
 *
 * **画面だけが動いていた。**端末は HTTP の一覧（`127.0.0.1:4177/v1/models`）
 * だけを見ていたが、この中で読む道では**その口はモデルを読むまで立たない**。
 * 保存先に GGUF が在っても必ず空になり、`使えるモデルがありません` で
 * exit 1 する。同じ状態で doctor は「動かせます。`npm run agent` で端末」と言う。
 * 案内された手が、その場で落ちていた。
 *
 * 相手を入れ替えた確かめでは見えない（入れ替えると口が立ってしまう）。**本物で通す。**
 */
async function cliReachesModel() {
  const { mkdtempSync, rmSync: rm, writeFileSync } = await import('node:fs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const home = mkdtempSync(join(tmpdir(), 'aas-real-cli-'));
  const models = join(home, 'models');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(models, { recursive: true });
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), join(models, 'tiny.gguf')], { stdio: 'pipe' });
  /*
   * **入口ごとに、別の口を使う。**
   *
   * 三つとも既定の口（4177）で待つので、前のものの子が落ちきる前に次を起こすと
   * 「モデルのプロセスが 1 で終わりました」になる。走らせる順で結果が変わるので、
   * 番号を分ける（**走らせるたびに変わる確かめを作らない**）。
   */
  const configFor = (port) => {
    const at = join(home, `aas.${port}.json`);
    writeFileSync(at, JSON.stringify({
      runtime: { kind: 'inproc', basePort: port }, initiative: { enabled: false },
    }));
    return at;
  };
  const config = configFor(41771);
  const work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, 'tasks.json'), JSON.stringify([
    { id: 't1', instruction: 'なにもしない', laneId: 'default' },
  ]));

  const env = {
    ...process.env, AAS_HOME: home, AAS_CONFIG: config, NO_COLOR: '1',
    AAS_REPORT_DIR: join(home, 'reports'),
  };
  const say = async (entry, args = [], at = config) => {
    const out = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', entry), ...args], {
      env: { ...env, AAS_CONFIG: at }, cwd: work, timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    }).catch((e) => e);
    // eslint-disable-next-line no-control-regex
    return `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  };

  const found = [];
  try {
    // どれも「使えるモデルがありません」で落ちないこと。
    // 名前が出ることまで見る。**落ちなかっただけでは、辿り着いた証拠にならない。**
    for (const [entry, args, want, port] of [
      ['agent.ts', [], /担当モデル: inproc:tiny\.gguf/, 41771],
      ['main.ts', [], /モデル: inproc:tiny\.gguf/, 41772],
      ['team.ts', [join(home, 'tasks.json')], /レーン default: inproc:tiny\.gguf/, 41773],
    ]) {
      const text = await say(entry, args, configFor(port));
      if (/使えるモデルがありません/.test(text)) {
        found.push(`${entry}: 保存先に GGUF が在るのに落ちる（${text.split('\n').find((l) => l.includes('使えるモデル'))}）`);
        continue;
      }
      if (!want.test(text)) found.push(`${entry}: モデルに辿り着いていない:\n${text.slice(0, 900)}`);
    }
  } catch (e) {
    found.push(`端末の入口で落ちました: ${e.message}`);
  } finally {
    rm(home, { recursive: true, force: true });
  }
  return found;
}

bad.push(...await throughSession());
bad.push(...await thinkingBudget());
bad.push(...await throughParallel());
bad.push(...await cliReachesModel());

if (bad.length > 0) {
  console.error(`見つかった不具合 ${bad.length} 件:`);
  for (const b of bad) console.error(`- ${b}`);
  process.exit(1);
}
console.log('本物のモデルで通りました（読み込み・窓・まとめて返す・流して返す・道具を渡す・同梱の話し方・土台ごと一往復・本物の数え方・先読みで答えが変わらない・考えごとの予算・二つ同時・端末の入口）');
