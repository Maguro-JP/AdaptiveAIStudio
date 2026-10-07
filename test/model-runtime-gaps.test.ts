/**
 * モデルを選ぶ・調べる・取ってくるところの不具合（45 回目の調査）。
 *
 * - Ollama を使っていると、頭（`ollama:`）を二度外して `qwen3.5:9b` が `9b` になり、新しい世代を一件も訊かなかった
 * - 雲のモデルの名前で配布元を探し、カタログの家族からも訊かなかった
 * - 配布元に繋がらなかったのを「新しい世代は無い」と言った
 * - KV の見積もりで、書いてある K・V の次元を読まず、Qwen3 では半分ほどに見積もった
 * - Ollama の取得で、二つ目以降の層の進み具合が出なかった
 * - GGUF の値の型の 4 バイトだけが打ち切りの外にあり、読む先頭の境目がそこに落ちると GGUF ごと読めない扱いになった
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { ggufHead } from './gguf-head.ts';
import { findNewerFor, findNewerOllama, findNewerGguf } from '../src/runtime/model-updates.ts';
import { localModelCandidates } from '../src/core/session.ts';
import { extractFacts, headDimOf, toModelSpec } from '../src/runtime/gguf-spec.ts';
import { fitWindow } from '../src/runtime/inproc.ts';
import { pullModel } from '../src/runtime/ollama-pull.ts';
import { readGguf } from '../src/runtime/gguf.ts';

const registry = {
  resolve(id: string) {
    const head = id.slice(0, id.indexOf(':'));
    const locality = head === 'anthropic' ? 'cloud' : 'local';
    return { provider: { locality } };
  },
};

describe('新しい世代を訊く', () => {
  test('**Ollama の候補は、家族の名前（qwen3.5）で訊く**（頭を二度外して 9b で訊いていた）', async () => {
    const asked: string[] = [];
    const fake = (async (url: string | URL) => { asked.push(String(url)); return new Response('{}', { status: 404 }); }) as unknown as typeof fetch;
    const local = localModelCandidates(['ollama:qwen3.5:9b'], registry);
    await findNewerFor({ runtimeKind: 'ollama', installed: local, fetchImpl: fake });
    assert.ok(asked.length > 0, '一件も訊いていない');
    assert.ok(asked.some((u) => u.includes('/qwen4/')), `次の世代を訊いていない: ${asked.join(' ')}`);
  });

  test('**雲のモデルの名前は、手元の候補に入れない**', () => {
    assert.deepEqual(
      localModelCandidates(['anthropic:claude-sonnet-4-5', 'inproc:Qwen3.5-4B-Q4_K_M.gguf'], registry),
      ['inproc:Qwen3.5-4B-Q4_K_M.gguf'],
    );
    assert.deepEqual(localModelCandidates(['anthropic:claude-sonnet-4-5'], registry), []);
  });

  for (const [what, fake] of [
    ['繋がらない', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch],
    ['断られた（403）', (async () => new Response('no', { status: 403 })) as unknown as typeof fetch],
  ] as const) {
    test(`**Ollama の配布元に${what}ときは「無い」と言わずに投げる**`, async () => {
      await assert.rejects(findNewerOllama({ installed: ['qwen3.5:9b'], fetchImpl: fake }), /訊けませんでした/);
    });
    test(`**Hugging Face に${what}ときは「無い」と言わずに投げる**`, async () => {
      await assert.rejects(findNewerGguf({ installed: ['Qwen3.5-4B-Q4_K_M.gguf'], fetchImpl: fake }), /訊けませんでした/);
    });
  }

  test('404 だけなら「無い」として空を返す（前と同じ）', async () => {
    const fake = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    assert.deepEqual(await findNewerOllama({ installed: ['qwen3.5:9b'], fetchImpl: fake }), []);
  });
});

describe('KV の見積もり', () => {
  // Qwen3-4B の諸元。embedding / heads = 80 だが、K・V の次元は 128
  const qwen3_4b = {
    'general.architecture': 'qwen3',
    'qwen3.block_count': 36,
    'qwen3.embedding_length': 2560,
    'qwen3.context_length': 40960,
    'qwen3.attention.head_count': 32,
    'qwen3.attention.head_count_kv': 8,
    'qwen3.attention.key_length': 128,
    'qwen3.attention.value_length': 128,
  };

  test('**書いてある key_length・value_length を読む**', async () => {
    const dir = await tempDir('aas-model-runtime-kv-');
    const path = join(dir, 'q.gguf');
    await writeFile(path, ggufHead(qwen3_4b));
    const facts = extractFacts(await readGguf(path));
    assert.equal(facts.keyLength, 128);
    assert.equal(headDimOf(facts), 128);
  });

  test('**K・V の次元で数え、embedding / heads より狭いコンテキストウィンドウにする**', () => {
    const base = { trained: 40960, layers: 36, embedding: 2560, heads: 32, kvHeads: 8, weightBytes: 2.5 * 1024 ** 3, ramBytes: 8 * 1024 ** 3, floor: 2048 };
    const guessed = fitWindow(base);
    const told = fitWindow({ ...base, headDim: 128 });
    assert.ok(told.window < guessed.window, `書いてある次元で数えていない: ${told.window} >= ${guessed.window}`);
  });

  test('書いていないモデルは、embedding / heads で代える（前と同じ）', () => {
    assert.equal(headDimOf({}), undefined);
    const base = { trained: 32768, layers: 32, embedding: 4096, heads: 32, kvHeads: 8, weightBytes: 4 * 1024 ** 3, ramBytes: 16 * 1024 ** 3 };
    assert.deepEqual(fitWindow({ ...base, headDim: 128 }), fitWindow(base));
  });

  test('**諸元にも、書いてある次元を使う**', async () => {
    const dir = await tempDir('aas-model-runtime-spec-');
    const path = join(dir, 'q.gguf');
    await writeFile(path, ggufHead(qwen3_4b));
    const r = toModelSpec(await readGguf(path));
    // テンソルが無いので量子化が分からず spec は出ない。facts から次元だけ見る
    assert.equal(headDimOf(r.facts), 128);
  });
});

describe('Ollama の取得の進み具合', () => {
  test('**二つ目の層も、数え直して割合を出す**', async () => {
    const lines = [
      { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 0 },
      { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 100 },
      { status: 'pulling b', digest: 'sha256:b', total: 50, completed: 0 },
      { status: 'pulling b', digest: 'sha256:b', total: 50, completed: 25 },
      { status: 'pulling b', digest: 'sha256:b', total: 50, completed: 50 },
      { status: 'success' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    const fake = (async () => new Response(lines)) as unknown as typeof fetch;
    const shown: string[] = [];
    await pullModel({ baseUrl: 'http://127.0.0.1:1', ref: 'x', fetchImpl: fake, onProgress: (t: string) => shown.push(t) });
    const pcts = shown.filter((t) => /%/.test(t)).map((t) => parseInt(t, 10));
    // 10% 刻みで出す（0% は出さない）。前は二つ目の層で何も出ず [100] だった
    assert.deepEqual(pcts, [100, 50, 100], `層ごとに数え直していない: ${shown.join(' / ')}`);
  });
});

describe('GGUF の読み', () => {
  test('**読む先頭の境目が値の型に落ちても、読めた所までを返す**', async () => {
    const dir = await tempDir('aas-model-runtime-gguf-');
    const path = join(dir, 'cut.gguf');
    const full = ggufHead({ 'general.architecture': 'qwen3', 'qwen3.block_count': 36 });
    await writeFile(path, full);
    // 最後の項目の名前の直後（型の 4 バイトの手前）で切る
    const file = await readGguf(path, { headBytes: full.length - 8 });
    assert.equal(file.metadata.get('general.architecture'), 'qwen3');
    assert.ok(file.warnings.length > 0, '読めなかったことを言っていない');
  });
});
