/**
 * llama-server が落ちたときの見立て。
 *
 * 当てはめでやっている以上、外れることがある。
 * だから「外れたときに、外れたと言うか」を重点的に見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, describeFailure } from '../src/runtime/llama-diagnosis.ts';

describe('落ち方の見立て', () => {
  test('VRAM 不足を見分ける', () => {
    const d = diagnose('ggml_backend_cuda_buffer_type_alloc: cudaMalloc failed: out of memory');
    assert.match(d.cause ?? '', /メモリが足りません/);
    assert.match(d.nextStep ?? '', /n-gpu-layers/);
  });

  test('ファイルが無いことを見分ける', () => {
    const d = diagnose("error: failed to open model.gguf: No such file or directory");
    assert.match(d.cause ?? '', /開けません/);
  });

  test('指定を理解できていないことを見分ける', () => {
    const d = diagnose('error: unknown argument: --flash-attn-type');
    assert.match(d.cause ?? '', /理解できていません/);
    assert.match(d.nextStep ?? '', /版が古い/);
  });

  test('対応していない形式を見分ける', () => {
    const d = diagnose('llama_model_load: error loading model: unknown model architecture: qwen4');
    assert.match(d.cause ?? '', /対応していません/);
  });

  test('口の取り合いを見分ける', () => {
    const d = diagnose('bind: Address already in use');
    assert.match(d.cause ?? '', /別のものが使っています/);
  });

  test('実行ファイルが無いことを見分ける', () => {
    const d = diagnose("'llama-server' is not recognized as an internal or external command");
    assert.match(d.cause ?? '', /実行ファイルが見つかりません/);
  });

  test('VRAM 不足は、読み込み失敗より先に見る', () => {
    // 両方の言葉が出る。順番を間違えると、役に立たない方を答えてしまう。
    const d = diagnose('failed to load model: cudaMalloc failed: out of memory');
    assert.match(d.cause ?? '', /メモリが足りません/);
  });

  test('見覚えが無ければ、見立てを付けない', () => {
    assert.deepEqual(diagnose('なにか知らない落ち方'), {});
  });
});

describe('人に見せる形', () => {
  test('見立てが付けば、次の一手まで書く', () => {
    const text = describeFailure(1, 'cudaMalloc failed: out of memory');
    assert.match(text, /終了コード 1/);
    assert.match(text, /cudaMalloc/, '生の出力が消えている');
    assert.match(text, /→ /);
    assert.match(text, /n-gpu-layers/);
  });

  test('見立てが付かなくても、生の出力は必ず出す', () => {
    const text = describeFailure(1, 'まったく未知の出力');
    assert.match(text, /まったく未知の出力/);
    assert.match(text, /見覚えのある落ち方ではありませんでした/,
      '分からないのに、分かったふりをしている');
  });

  test('終了コードが取れなくても壊れない', () => {
    assert.match(describeFailure(null, ''), /終了コード 不明/);
  });
});
