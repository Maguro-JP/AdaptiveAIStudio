/**
 * 置き方を選ぶ（docs/PLACEMENT.md の「置き方を選ぶ」）。
 *
 * 同じモデルの動く置き方を並べ、1 回押して選び、覚えて次も使い、「おまかせ」で戻す。入らないモデルには、動く形（一覧に在る別の版）を
 * 先に出す。ここは、計算・覚え・読み込みの引数・画面の API・画面の部品・doctor を、偽のライブラリと試験の口で見る。
 * 機械は並べて渡すか、試験の口（AAS_TEST_*）で決める。走らせる場所で結果が変わらない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { cleanAasEnv } from './env.ts';
import { installDom, type StubNode } from './dom-stub.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import {
  placementOptions, placementAlternatives, planPlacement, optionWant, optionLines, pickOption, GIB, LONG_CONTEXT_CAP,
  type PlacementCandidate, type PlacementMachine, type PlacementModel,
} from '../src/runtime/placement.ts';
import { catalogMatch, catalogVersions, lookupCatalog, lookupVariant, quantOf, AVAILABLE_MODELS, QUANT_VARIANTS } from '../src/runtime/model-catalog.ts';

// 覚えを置く所を、試験専用の場所へ移してから読み込む
const STATE = await tempDir('aas-options-state-');
process.env.AAS_STATE_DIR = STATE;
const { InProcRuntime } = await import('../src/runtime/inproc.ts');
const { UiServer } = await import('../src/ui/server.ts');
const { chosenOption, choicesFile, readChoices, setChoice } = await import('../src/runtime/placement-choice.ts');

const MB = 1024 ** 2;
const run = promisify(execFile);
const root = installRoot();

const M9: PlacementModel = { ref: 'Qwen3.5-9B-Q4_K_M.gguf', fileBytes: 5_680_522_464, layers: 32, kvBytesPerToken: 131_072, trainedContext: 262_144, downloaded: true };
const M27: PlacementModel = { ref: 'Qwen3.6-27B-Q4_K_M.gguf', fileBytes: 16_817_244_384, layers: 64, kvBytesPerToken: 262_144, trainedContext: 262_144, downloaded: true };
const cpu = (ramGb: number): PlacementMachine => ({ ramBytes: ramGb * GIB, gpus: [], cores: 8, swapBytes: 0 });
const windows = (ramGb: number, freeGb: number, vramGb = 0): PlacementMachine => ({
  ramBytes: ramGb * GIB, gpus: vramGb > 0 ? [{ vramBytes: vramGb * GIB, name: 'GPU' }] : [], cores: 8,
  swapGrows: true, systemDiskFreeBytes: freeGb * GIB,
});
/** 取ってくる一覧（本物）を、別の版の候補にする。 */
const fromCatalog = (): PlacementCandidate[] => catalogVersions().map((v) => ({
  id: v.id, family: v.family, quant: v.quant,
  model: { ref: v.id, fileBytes: v.bytes, ...(v.facts ? { layers: v.facts.layers, kvBytesPerToken: v.facts.kvBytesPerToken, ...(v.facts.activeRatio ? { activeRatio: v.facts.activeRatio } : {}) } : {}) },
}));

describe('同じモデルの、動く置き方を並べる', () => {
  test('32GB + VRAM 8GB の 27B: おまかせ（既定）・速さを取る・長く覚える。どれにも速さ・メモリ・短所が 1 行で付く', () => {
    const options = placementOptions(M27, windows(32, 100, 8));
    assert.deepEqual(options.map((o) => o.id), ['auto', 'short', 'long']);
    assert.deepEqual(options.map((o) => o.isDefault), [true, false, false], '既定は 1 つだけで、先頭');
    const [auto, short, long] = options as [typeof options[0], typeof options[0], typeof options[0]];
    assert.equal(short.label, '速さを取る');
    assert.ok(short.plan.estimatedTps > auto.plan.estimatedTps, '速さを取ると言うのに、速くない');
    assert.equal(short.plan.contextSize, 4096);
    assert.equal(long.plan.contextSize, LONG_CONTEXT_CAP);
    assert.ok(long.plan.estimatedTps < auto.plan.estimatedTps);
    for (const o of options) assert.match(o.line, /^目安 [\d.]+ tok\/s・.*メモリ [\d.]+GB.*・コンテキストウィンドウ \d+。短所: .+$/, o.line);
    assert.match(short.line, /短所: 長い会話やファイルは 4096 トークンで切れます/);
    assert.match(long.line, /短所: おまかせより遅くなります/);
  });

  test('狭めても速くならない機械（GPU なし・メモリに載る）では、「速さを取る」と言わず「メモリを少なめに」と言う', () => {
    const short = placementOptions(M9, cpu(16)).find((o) => o.id === 'short')!;
    assert.equal(short.label, 'メモリを少なめに');
  });

  test('おまかせと変わらない置き方は並べない（もう下限まで狭めてある機械に「速さを取る」は無い）', () => {
    const options = placementOptions(M9, windows(8, 100));
    assert.equal(options[0]!.plan.contextSize, 4096);
    assert.deepEqual(options.map((o) => o.id), ['auto', 'long']);
    assert.match(options[1]!.line, /短所: SSD から読む分が増えて、とても遅くなります/);
  });

  test('入らないモデルは、おまかせだけ（動かない置き方を選ばせない）', () => {
    const options = placementOptions(M27, cpu(16));
    assert.equal(options.length, 1);
    assert.equal(options[0]!.plan.possible, false);
  });

  test('選んだ置き方が並びに無ければ、おまかせに戻す。一覧には「既定」と「選択中」を言葉で付ける', () => {
    const options = placementOptions(M9, windows(8, 100));
    assert.equal(pickOption(options, 'short').id, 'auto');
    assert.equal(pickOption(options, 'long').id, 'long');
    const lines = optionLines(options, 'long');
    assert.match(lines[0]!, /^おまかせ（既定）: /);
    assert.match(lines[1]!, /^長く覚える（選択中）: /);
    assert.match(optionLines(options, undefined)[0]!, /^おまかせ（既定）（選択中）: /);
  });

  test('置き方は、計画に渡す望みになる（短く: 下限と 1 本。長く: 縮めない）', () => {
    assert.deepEqual(optionWant('auto', M9, { context: 8192 }), { context: 8192 });
    assert.equal(optionWant('short', M9, { context: 8192 }).lowRam, true);
    const long = optionWant('long', M9, { context: 8192 });
    assert.equal(long.context, LONG_CONTEXT_CAP);
    assert.equal(long.minContext, LONG_CONTEXT_CAP);
    // 学習した長さより長くは開かない
    assert.equal(optionWant('long', { trainedContext: 16_384 }, {}).context, 16_384);
  });
});

describe('入らないモデルに、動く形を出す（取ってくる一覧に在るものだけ）', () => {
  test('20GB・GPU なし・swap なしの 27B（入らない）: 一覧に在る 1 つ小さい量子化が、全部メモリに入ると出る', () => {
    const machine = cpu(20);
    const plan = planPlacement(M27, machine);
    assert.equal(plan.possible, false);
    const got = placementAlternatives({ ...catalogMatch(M27.ref), fileBytes: M27.fileBytes, plan }, fromCatalog(), machine);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.kind, 'smaller-quant');
    assert.equal(got[0]!.id, 'qwen3.6-27b@q3_k_m');
    assert.match(got[0]!.line, /^1 つ小さい量子化（q3_k_m・12\.7GB）なら、全部メモリに入ります。目安 [\d.]+ tok\/s・メモリ [\d.]+GB。短所: 量子化が粗い分、答えの質が落ちることがあります$/);
  });

  test('一覧に量子化の違う版が無ければ、言わない（作り話をしない）。入らないなら、動く別のモデルを出す', () => {
    const machine = cpu(16);
    const plan = planPlacement(M27, machine);
    const onlyQ4 = fromCatalog().filter((c) => !c.id.includes('@'));
    const got = placementAlternatives({ ...catalogMatch(M27.ref), fileBytes: M27.fileBytes, plan }, onlyQ4, machine);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.kind, 'smaller-model');
    assert.match(got[0]!.line, /^小さいモデル（qwen3\.5-9b・5\.3GB）なら、全部メモリに入ります。.*短所: 別のモデルなので、答えの質が変わります$/);
    // 候補が一つも無ければ、何も出さない
    assert.deepEqual(placementAlternatives({ fileBytes: M27.fileBytes, plan }, [], machine), []);
  });

  test('快適なモデルと、具合の上がらない版には、何も出さない（対）', () => {
    const fast = windows(32, 100, 24);
    const ok = planPlacement(M9, fast);
    assert.equal(ok.fit, 'comfortable');
    assert.deepEqual(placementAlternatives({ ...catalogMatch(M9.ref), fileBytes: M9.fileBytes, plan: ok }, fromCatalog(), fast), []);
    // 16GB の Windows: 小さい量子化も SSD から読むことになる。具合が上がらないので出さない
    const paged = windows(16, 200);
    const ssd = planPlacement(M27, paged);
    assert.equal(ssd.fit, 'ssd');
    assert.deepEqual(placementAlternatives({ ...catalogMatch(M27.ref), fileBytes: M27.fileBytes, plan: ssd }, fromCatalog(), paged), []);
  });

  test('量子化の違う版は、元の版が一覧に在り、元より小さい。取ってくるときは同じ配布元の、その量子化', () => {
    assert.ok(QUANT_VARIANTS.length >= 1);
    for (const v of QUANT_VARIANTS) {
      const base = lookupCatalog(v.of);
      assert.ok(base, `${v.of} が一覧に無い`);
      assert.ok(v.bytes < base!.facts!.bytes, `${v.of}@${v.quant} が元より大きい`);
      const e = lookupVariant(`${v.of}@${v.quant}`)!;
      assert.equal(e.repo, base!.repo);
      assert.equal(e.quant, v.quant);
      assert.equal(e.facts!.layers, base!.facts!.layers);
    }
    assert.equal(lookupVariant('qwen3.6-27b@q2_k'), undefined, '一覧に無い量子化を、在ることにしている');
    assert.equal(lookupCatalog('qwen3.6-27b@q3_k_m'), undefined, '元の一覧の引き方が変わっている');
    assert.equal(catalogVersions().length, AVAILABLE_MODELS.length + QUANT_VARIANTS.length);
  });

  test('手元のファイルの名前から、一覧のどのモデルのどの量子化かを読む', () => {
    assert.deepEqual(catalogMatch('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'), { family: 'unsloth/Qwen3.6-35B-A3B-GGUF', quant: 'q4_k_m' });
    assert.deepEqual(catalogMatch('Qwen3.5-27B-Q3_K_M.gguf'), { family: 'unsloth/Qwen3.5-27B-GGUF', quant: 'q3_k_m' });
    assert.equal(catalogMatch('tiny.gguf'), undefined);
    assert.equal(quantOf('big.gguf'), undefined);
  });
});

describe('選んだ置き方を覚える', () => {
  test('選ぶと残り、おまかせに戻すと消える。壊れたファイルは、何も選んでいないものとして読む', async () => {
    const dir = await tempDir('aas-options-choice-');
    assert.equal(await chosenOption('a.gguf', dir), 'auto');
    await setChoice('a.gguf', 'long', dir);
    await setChoice('b.gguf', 'short', dir);
    assert.equal(await chosenOption('a.gguf', dir), 'long');
    assert.deepEqual(await readChoices(dir), { 'a.gguf': 'long', 'b.gguf': 'short' });
    await setChoice('a.gguf', 'auto', dir);
    assert.deepEqual(JSON.parse(await readFile(choicesFile(dir), 'utf8')), { version: 1, choices: { 'b.gguf': 'short' } });
    await writeFile(choicesFile(dir), '{ こわれた');
    assert.equal(await chosenOption('b.gguf', dir), 'auto');
    await writeFile(choicesFile(dir), JSON.stringify({ choices: { 'b.gguf': 'fastest' } }));
    assert.equal(await chosenOption('b.gguf', dir), 'auto', '知らない置き方を、そのまま使っている');
  });
});

/** 中身の無い（疎な）.gguf。大きさだけが本物。 */
async function sparse(dir: string, name: string, bytes: number): Promise<void> {
  const fh = await open(join(dir, name), 'w');
  try { await fh.write('GGUF'); await fh.truncate(bytes); } finally { await fh.close(); }
}

function fakeLib(contexts: Record<string, unknown>[]) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async (o: { onLoadProgress?: (d: number) => void }) => {
        o.onLoadProgress?.(1);
        return {
          dispose: async () => {},
          createContext: async (c: Record<string, unknown>) => { contexts.push(c); return { getSequence: () => ({}), dispose: async () => {} }; },
        };
      },
    }),
    LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
  });
}

describe('選んだ置き方で読む', () => {
  async function loadWith(choice: 'auto' | 'short' | 'long' | undefined): Promise<{ context: Record<string, unknown>; said: string[] }> {
    const dir = await tempDir('aas-options-load-');
    const state = await tempDir('aas-options-load-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    if (choice) await setChoice('big.gguf', choice, state);
    const contexts: Record<string, unknown>[] = [];
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib(contexts), onLog: (l) => said.push(l) });
    try { await rt.ensureLoaded('big.gguf'); } finally { await rt.shutdown(); }
    return { context: contexts[0]!, said };
  }

  test('「メモリを少なめに」を選んであると、コンテキストウィンドウを下限で開き、記録に選んだ置き方を言う', async () => {
    const got = await loadWith('short');
    assert.equal(got.context.contextSize, 4096);
    assert.ok(got.said.some((l) => l === 'big.gguf: 選んである置き方（メモリを少なめに）で読みます'), got.said.join(' / '));
  });

  test('選んでいなければ、今までどおりの長さで開き、選んだとは言わない（対）', async () => {
    const got = await loadWith(undefined);
    assert.equal(got.context.contextSize, 8192);
    assert.ok(!got.said.some((l) => l.includes('選んである置き方')), got.said.join(' / '));
  });

  test('おまかせに戻すと、元の長さに戻る', async () => {
    const dir = await tempDir('aas-options-back-');
    const state = await tempDir('aas-options-back-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const open = async (): Promise<unknown> => {
      const contexts: Record<string, unknown>[] = [];
      const rt = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib(contexts) });
      try { await rt.ensureLoaded('big.gguf'); } finally { await rt.shutdown(); }
      return contexts[0]!.contextSize;
    };
    await setChoice('big.gguf', 'short', state);
    assert.equal(await open(), 4096);
    await setChoice('big.gguf', 'auto', state);
    assert.equal(await open(), 8192);
  });
});

async function withEnv<T>(set: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) { before[k] = process.env[k]; process.env[k] = v; }
  try { return await body(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

interface Row {
  ref: string; fit?: string; plan?: string; chosen?: string; detail?: string[];
  options?: Array<{ id: string; label: string; line: string; isDefault: boolean; chosen: boolean }>;
  alternatives?: Array<{ id: string; kind: string; line: string; downloaded: boolean }>;
}

describe('画面の API で選ぶ・戻す', () => {
  // メモリ 1MB・ページング 64GB の機械に見せた 3MB のモデル: おまかせ（4096）と、長く覚える（8192）の 2 通り
  const HOOKS = { AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(64 * GIB), AAS_TEST_DISK_BYTES: String(18 * GIB) };

  test('一覧に選べる置き方が付き、PUT で選ぶと覚えて一行と「計画を見る」が変わり、おまかせで戻る。動かない置き方は選べない', async () => {
    const models = await tempDir('aas-options-ui-');
    await sparse(models, 'big.gguf', 3 * MB);
    await withEnv(HOOKS, async () => {
      const server = new UiServer({
        config: {
          providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: models },
          agent: { root: await tempDir('aas-options-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
        } as never,
        port: 0, inprocLoad: fakeLib([]) as never,
      });
      try {
        const base = (await server.start()).replace(/\/$/, '');
        const list = async (): Promise<Row> => ((await (await fetch(`${base}/api/models`)).json()) as { installed: Row[] }).installed.find((m) => m.ref === 'big.gguf')!;
        const put = (option: string, ref = 'big.gguf') => fetch(`${base}/api/models/placement`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, option }),
        });

        const before = await list();
        assert.deepEqual(before.options?.map((o) => [o.id, o.isDefault, o.chosen]), [['auto', true, true], ['long', false, false]]);
        assert.equal(before.chosen, 'auto');
        assert.ok(before.detail?.includes('コンテキストウィンドウ: 4096 × 並列 1 本（KV はメモリ）'), before.detail?.join(' / '));

        const picked = await put('long');
        assert.equal(picked.status, 200);
        const said = await picked.json() as { chosen: string; note: string; when: string };
        assert.equal(said.chosen, 'long');
        assert.equal(said.note, '「長く覚える」で置きます。');
        assert.equal(said.when, '次の送信で、この置き方で読みます。');
        assert.equal(await chosenOption('big.gguf'), 'long', '選んだものを覚えていない');
        const after = await list();
        assert.equal(after.chosen, 'long');
        assert.deepEqual(after.options?.map((o) => o.chosen), [false, true]);
        assert.ok(after.detail?.includes('コンテキストウィンドウ: 8192 × 並列 1 本（KV はメモリ）'), `選んだ置き方の計画になっていない: ${after.detail?.join(' / ')}`);

        // この機械では動かない・変わらない置き方、知らない置き方、手元に無いモデルは、選べない
        assert.equal((await put('short')).status, 409);
        assert.equal((await put('fastest')).status, 400);
        assert.equal((await put('long', 'nothing.gguf')).status, 404);
        assert.equal(await chosenOption('big.gguf'), 'long', '断ったのに、覚えが変わっている');

        const back = await put('auto');
        assert.equal((await back.json() as { note: string }).note, '既定の置き方に戻しました。');
        assert.equal(await chosenOption('big.gguf'), 'auto');
        assert.equal((await list()).chosen, 'auto');
      } finally { await server.stop(); }
    });
  });

  test('入らないモデルの行に、動く形（一覧に在る別の版）が付く', async () => {
    const models = await tempDir('aas-options-ui-no-');
    await sparse(models, 'Qwen3.6-27B-Q4_K_M.gguf', 3 * MB);
    // 3MB のモデルも入らない機械（メモリ 1MB・ページングなし）。一覧のどれも入らないので、動く形は出ない
    const none = await withEnv({ AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: '0' }, async () => {
      const server = new UiServer({
        config: {
          providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: models },
          agent: { root: await tempDir('aas-options-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
        } as never,
        port: 0, inprocLoad: fakeLib([]) as never,
      });
      try {
        const base = (await server.start()).replace(/\/$/, '');
        return ((await (await fetch(`${base}/api/models`)).json()) as { installed: Row[]; catalog: Row[] });
      } finally { await server.stop(); }
    });
    assert.equal(none.installed[0]!.fit, 'no');
    assert.deepEqual(none.installed[0]!.alternatives, [], '動かないものを、動く形として出している');
    for (const m of none.catalog) assert.deepEqual(m.alternatives, []);
  });
});

installDom();
const { placementChoices, placementAlternatives: alternativesNode } = await import('../src/ui/web/placement.js') as unknown as {
  placementChoices: (m: unknown, o?: { onChange?: () => unknown; say?: (t: string, ok: boolean) => void }) => StubNode | null;
  placementAlternatives: (m: unknown, o?: { say?: (t: string, ok: boolean) => void }) => StubNode | null;
};

describe('画面の部品', () => {
  const realFetch = globalThis.fetch;
  const row = {
    ref: 'big.gguf', fit: 'slow', chosen: 'auto',
    options: [
      { id: 'auto', label: 'おまかせ', line: '目安 2.4 tok/s・メモリ 11.2GB。短所: 遅いです', isDefault: true, chosen: true },
      { id: 'short', label: '速さを取る', line: '目安 2.5 tok/s・メモリ 10.1GB。短所: 長い会話やファイルは 4096 トークンで切れます', isDefault: false, chosen: false },
    ],
  };

  test('置き方ごとに押せる行が出て、既定と選択中を言葉で言う。1 回押すと選ぶ API を呼び、描き直し、結果を言う', async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}), body: JSON.parse(init?.body ?? 'null') });
      return Response.json({ ok: true, chosen: 'short', note: '「速さを取る」で置きます。', when: '次の送信で、この置き方で読みます。' });
    }) as unknown as typeof fetch;
    try {
      let redrawn = 0;
      const said: Array<[string, boolean]> = [];
      const node = placementChoices(row, { onChange: () => { redrawn += 1; }, say: (t, ok) => said.push([t, ok]) })!;
      assert.equal(node.tagName.toLowerCase(), 'div', '遅いモデルでは、畳まずに出す（1 回で押せる）');
      const buttons = node.buttons();
      assert.equal(buttons.length, 2);
      assert.match(buttons[0]!.text, /● おまかせ（既定）（選択中）/);
      assert.match(buttons[1]!.text, /○ 速さを取る/);
      assert.match(buttons[1]!.text, /短所: 長い会話やファイルは 4096 トークンで切れます/);
      await buttons[1]!.onclick!();
      assert.deepEqual(calls, [{ url: '/api/models/placement', method: 'PUT', body: { ref: 'big.gguf', option: 'short' } }]);
      assert.equal(redrawn, 1);
      assert.deepEqual(said, [['big.gguf: 「速さを取る」で置きます。次の送信で、この置き方で読みます。', true]]);
      // 選んであるものを押しても、何も送らない
      await buttons[0]!.onclick!();
      assert.equal(calls.length, 1);
    } finally { globalThis.fetch = realFetch; }
  });

  test('選べなかったら、理由を言い、描き直さず、もう一度押せる', async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({ error: 'この PC では、その置き方は選べません' }, { status: 409 })) as unknown as typeof fetch;
    try {
      let redrawn = 0;
      const said: Array<[string, boolean]> = [];
      const node = placementChoices(row, { onChange: () => { redrawn += 1; }, say: (t, ok) => said.push([t, ok]) })!;
      await node.buttons()[1]!.onclick!();
      assert.equal(redrawn, 0);
      assert.deepEqual(said, [['この PC では、その置き方は選べません', false]]);
      assert.equal(Boolean(node.buttons()[1]!.disabled), false);
    } finally { globalThis.fetch = realFetch; }
  });

  test('快適で何も選んでいないモデルでは畳む。置き方が 1 つなら出さない（対）', () => {
    const folded = placementChoices({ ...row, fit: 'comfortable' })!;
    assert.equal(folded.tagName.toLowerCase(), 'details');
    assert.match(folded.text, /置き方を選ぶ（2 通り）/);
    assert.equal(placementChoices({ ...row, options: [row.options[0]] }), null);
    assert.equal(placementChoices({ ref: 'x' }), null);
  });

  test('動く形: 一覧に在る別の版を 1 行で言い、手元に無ければ 1 回押して取ってくる', async () => {
    const calls: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { body?: string }) => {
      calls.push([String(url), JSON.parse(init?.body ?? 'null')]);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const said: string[] = [];
      const node = alternativesNode({
        alternatives: [{ id: 'qwen3.6-27b@q3_k_m', kind: 'smaller-quant', line: '1 つ小さい量子化（q3_k_m・12.7GB）なら、全部メモリに入ります。', downloaded: false }],
      }, { say: (t) => said.push(t) })!;
      assert.match(node.text, /動く形: 1 つ小さい量子化（q3_k_m・12\.7GB）なら、全部メモリに入ります。/);
      const get = node.buttons()[0]!;
      assert.equal(get.textContent, 'qwen3.6-27b@q3_k_m を取ってくる');
      await get.onclick!();
      assert.deepEqual(calls, [['/api/models/get', { id: 'qwen3.6-27b@q3_k_m' }]]);
      assert.deepEqual(said, ['qwen3.6-27b@q3_k_m を取ってきています。終わると一覧に出ます。']);
      assert.equal(alternativesNode({ alternatives: [] }), null);
      // 手元に在る版には、取ってくるボタンを出さない
      const have = alternativesNode({ alternatives: [{ id: 'x', kind: 'smaller-quant', line: 'x なら動きます', downloaded: true }] })!;
      assert.equal(have.buttons().length, 0);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('doctor に、同じ置き方が出る', () => {
  async function doctor(choice: 'long' | undefined, env: Record<string, string>): Promise<string> {
    const dir = await tempDir('aas-options-doc-');
    const models = join(dir, 'models');
    const home = join(dir, 'home');
    await mkdir(models, { recursive: true });
    await mkdir(home, { recursive: true });
    await sparse(models, 'big.gguf', 3 * MB);
    if (choice) await setChoice('big.gguf', choice, home);
    const config = join(dir, 'aas.config.json');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
    const out = await run(process.execPath, [...flags, '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')], {
      env: cleanAasEnv({ AAS_HOME: home, AAS_CONFIG: config, AAS_REPORT_DIR: join(dir, 'reports'), NO_COLOR: '1', ...env }), timeout: 300_000,
    }).catch((e: { stdout?: string; stderr?: string }) => e);
    // eslint-disable-next-line no-control-regex
    return `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  }
  const HOOKS = { AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(8 * GIB) };

  test('選べる置き方が、既定と選択中を添えて出る。選んであれば、その置き方の一行になる', async () => {
    const plain = await doctor(undefined, HOOKS);
    assert.match(plain, /置き方: おまかせ（既定）（選択中）: 目安 [\d.]+ tok\/s・.*コンテキストウィンドウ 4096。短所: SSD から読むので、とても遅いです/, plain.slice(-1500));
    assert.match(plain, /置き方: 長く覚える: 目安 [\d.]+ tok\/s・.*コンテキストウィンドウ 8192。短所: /);
    const chosen = await doctor('long', HOOKS);
    assert.match(chosen, /置き方: おまかせ（既定）: /, chosen.slice(-1500));
    assert.match(chosen, /置き方: 長く覚える（選択中）: /);
  });

  test('メモリに載る小さいモデルでも、置き方を選んであれば言う。選んでいなければ言わない（対）', async () => {
    // 口を立てない機械では、3MB のモデルは快適。見当の長さ 8192 より長くは開けないので「長く覚える」は無く、「メモリを少なめに」だけ
    const dir = await doctor(undefined, {});
    assert.doesNotMatch(dir, /置き方: /);
  });
});
