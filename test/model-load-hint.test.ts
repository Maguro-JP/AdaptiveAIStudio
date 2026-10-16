/**
 * モデルを読み込めなかったとき、ファイルのせいか、読む側のせいかを取り違えない。
 *
 * 「ファイルが途中までしか落ちていない」と言うと、読む人はファイルを消して取り直す（数GB）。読む側（node-llama-cpp）で
 * 止まっているときや、ファイルが無いときにそう言うと、消しても直らない。見分けを失敗の文の全体に当てていたので、
 * 文に入るモデルの場所（`….gguf`）や llama.cpp の関数名（`gguf_init_from_file`）で、ほぼいつも「ファイルのせい」になっていた。
 *
 * 例は実物の文を使う（llama-server の出力は `test/fixtures/llama/`、node-llama-cpp は投げる文そのもの）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { looksLikeBrokenModelFile } = await import('../src/ui/server.ts');
const { describeFailure } = await import('../src/runtime/llama-diagnosis.ts');
const { answeredVersion } = await import('../src/runtime/llama-install.ts');
const fixture = (name: string) => readFile(join(import.meta.dirname, 'fixtures', 'llama', `${name}.txt`), 'utf8');

test('**形の違うファイルは、ファイルのせいと言う**（llama-server・node-llama-cpp の実物の文）', async () => {
  assert.equal(looksLikeBrokenModelFile(describeFailure(1, await fixture('bad-format'))), true, 'llama-server の bad-format');
  assert.equal(looksLikeBrokenModelFile('Invalid GGUF magic. Expected "GGUF" but got "こんに".'), true);
  // 途中までしか落ちていないときの llama.cpp の文（場所を含む）
  assert.equal(looksLikeBrokenModelFile("llama_model_load: error loading model: tensor 'blk.3.ffn_up.weight' data is not within the file bounds, model is corrupted or incomplete /home/me/.aas/models/a.gguf"), true);
});

test('**ファイルが無いとき・読む側で止まったときは、場所に .gguf が入っていても「ファイルのせい」にしない**', async () => {
  assert.equal(looksLikeBrokenModelFile(describeFailure(1, await fixture('missing-file'))), false, 'ファイルが無いのに、消して取り直せと言う');
  assert.equal(looksLikeBrokenModelFile(describeFailure(127, await fixture('missing-lib'))), false, '読む側の部品が無いのに、ファイルのせいにした');
  assert.equal(looksLikeBrokenModelFile('Failed to load model'), false);
  assert.equal(looksLikeBrokenModelFile('A context size of 131072 is too large for the available VRAM'), false);
  assert.equal(looksLikeBrokenModelFile('Failed to load model /home/me/.aas/models/qwen3-4b-q4_k_m.gguf'), false);
  // 場所の名前に決め手の句が入っていても、場所の字では決めない
  assert.equal(looksLikeBrokenModelFile('Failed to load model C:\\Users\\me\\models-incomplete\\qwen.gguf'), false);
});

/**
 * `llama-server --version` が動いたかを、出力に「version」が在るかで見ていた。動かなかったときの出力には実行ファイルの場所や
 * GLIBC の版の話が入るので、動かないのに「動く」と言っていた（doctor・selftest）。
 */
test('**動かなかったときの出力で、「動く」と言わない**', async () => {
  assert.equal(answeredVersion('/bin/sh: 1: /opt/app-version2/bin/llama-server: Permission denied'), false);
  assert.equal(answeredVersion("/opt/aas/bin/llama-server: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /opt/aas/bin/llama-server)"), false);
  assert.equal(answeredVersion(await fixture('missing-lib')), false);
  assert.equal(answeredVersion('version: 4585 (f0d4b29e)\nbuilt with cc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0 for x86_64-linux-gnu'), true);
  // GPU 版は、版の行の前に部品を読んだ行を出す
  assert.equal(answeredVersion('ggml_cuda_init: found 1 CUDA devices:\nversion: 4585 (f0d4b29e)'), true);
});

describe('見せる版の行', () => {
  test('CUDA 版の初期化の行が先に出ても、版の行を拾う', async () => {
    const { versionLine } = await import('../src/runtime/llama-install.ts');
    const out = 'ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 3060\nload_backend: loaded CUDA backend\nversion: 4585 (f0d4b29e)\nbuilt with MSVC\n';
    assert.equal(versionLine(out), 'version: 4585 (f0d4b29e)');
  });
  test('版の行が無ければ一行目（対）', async () => {
    const { versionLine } = await import('../src/runtime/llama-install.ts');
    assert.equal(versionLine('\nsomething else\nmore'), 'something else');
  });
});
