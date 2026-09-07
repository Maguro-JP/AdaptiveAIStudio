/**
 * モデルを読むライブラリとの約束。
 *
 * inproc.ts は node-llama-cpp の形に寄りかかっている。試験では読み込みを
 * 差し替えているので、**本物の形が変わっても気づけない**。
 * ライブラリがある場所では、こちらが呼んでいる形が本当にあるかを見る。
 *
 * 本物のモデルは用意できない（数GBある）ので、読ませはしない。
 * 「呼べる形か」だけを見る。**動くことの証明ではない**と、はっきりさせておく。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { installRoot } from '../src/core/home.ts';
const LLAMA_LIB = 'node-llama-cpp'; // 型検査に解決させない（src/runtime/inproc.ts 参照）

const DIST = join(installRoot(), 'node_modules', 'node-llama-cpp', 'dist');

/*
 * 入っていない場所（作業コピーの既定）では飛ばす。
 *
 * **`dist/` が在るかだけを見ていた。**組んだものは `dist/` ごと入るが、
 * 型宣言（`.d.ts`）は落とす。飛ばす側にも回らず、読みに行って
 * 「そんなファイルは無い」で落ちた（組んだものの中で回して出た。3 件）。
 *
 * ここで見たいのは本物の宣言なので、**宣言そのものが在るか**で決める。
 * 組んだものの中では、ライブラリは組んだ時点で固まっていて、ずれようが
 * ないので、確かめる意味も無い。
 */
const has = await stat(join(DIST, 'index.d.ts')).then(() => true, () => false);
const onlyWithLib = {
  skip: has ? false : 'node-llama-cpp の型宣言がありません（組んだものには入りません）',
};

async function d(...parts: string[]): Promise<string> {
  return readFile(join(DIST, ...parts), 'utf8');
}

describe('node-llama-cpp との約束', () => {
  test('入口が揃っている', onlyWithLib, async () => {
    const index = await d('index.d.ts');
    for (const name of ['getLlama', 'LlamaChatSession']) {
      assert.match(index, new RegExp(`\\b${name}\\b`), `${name} が無い`);
    }
  });

  test('こちらが呼んでいる形が、本物にある', onlyWithLib, async () => {
    // llama.loadModel({ modelPath })
    assert.match(await d('bindings', 'Llama.d.ts'), /loadModel\(options: LlamaModelOptions\)/);
    assert.match(await d('evaluator', 'LlamaModel', 'LlamaModel.d.ts'), /modelPath: string/);
    // model.createContext()
    assert.match(await d('evaluator', 'LlamaModel', 'LlamaModel.d.ts'),
      /createContext\(options\?: LlamaContextOptions\)/);
    // context.getSequence() と dispose()
    const ctx = await d('evaluator', 'LlamaContext', 'LlamaContext.d.ts');
    assert.match(ctx, /getSequence\(/);
    assert.match(ctx, /dispose\(\): Promise<void>/);
    // new LlamaChatSession({ contextSequence }).prompt(text) -> string
    const chat = await d('evaluator', 'LlamaChatSession', 'LlamaChatSession.d.ts');
    assert.match(chat, /contextSequence: LlamaContextSequence/);
    assert.match(chat, /prompt<[^>]*>\(prompt: string[\s\S]{0,400}?\): Promise<string>/);
  });

  test('実行ファイルを増やさない、が守られている', onlyWithLib, async () => {
    // この道を選んだ理由そのもの。.exe が混ざったら意味が無くなる。
    const { readdir } = await import('node:fs/promises');
    const bins = join(installRoot(), 'node_modules', '@node-llama-cpp');
    const found: string[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const e of await readdir(at, { withFileTypes: true }).catch(() => [])) {
        const p = join(at, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.toLowerCase().endsWith('.exe')) found.push(p);
      }
    };
    await walk(bins);
    assert.deepEqual(found, [], '実行ファイルが混ざっている');
  });
});

describe('入っているなら、読み込めること', () => {
  // dist/index.js が在るだけでは足りない。import の時点で llama/ の JSON を
  // 読むので、そこを消したbundle は**在るのに読み込めない**。それを配った。
  test('import が通る', onlyWithLib, async () => {
    await import(LLAMA_LIB);
  });

  test('import 時に読む JSON が残っている', onlyWithLib, async () => {
    const at = join(installRoot(), 'node_modules', 'node-llama-cpp', 'llama', 'binariesGithubRelease.json');
    await stat(at);
  });

  test('build: never を受け付ける形が本物にある', onlyWithLib, async () => {
    // 無ければ既定で llama.cpp を取ってきて組みに行く。網の無い機械では固まる。
    assert.match(await d('bindings', 'getLlama.d.ts'), /build\?:.*"never"/);
    // 向こうの声（prebuilt binary was not found）を落とす口。
    assert.match(await d('bindings', 'getLlama.d.ts'), /logLevel\?:/);
    // 文脈の大きさを数で渡せること。auto に任せると 8GB の機械で足りなくなる。
    assert.match(await d('evaluator', 'LlamaContext', 'types.d.ts'), /contextSize\?: "auto" \| number/);
  });
});
