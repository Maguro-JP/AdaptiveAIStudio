/**
 * モデルの取得の不具合（92 回目の調査）。
 *
 * - `--quant q4_k` が `q4_k_m` にも `q4_k_s` にも当たり、短い方を黙って選んでいた。`q4_0` が `iq4_0` に当たった
 * - 持ち主の名前が `blob` の HuggingFace の頁の場所を、ファイルの場所へ直せなかった（HTML を落として読めないと言った）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModelFile, hfFileUrl } from '../src/runtime/model-install.ts';

test('量子化の名前は一語として当てる（前に続きのある名前・後ろに続きのある名前に当てない）', () => {
  assert.equal(pickModelFile(['Qwen-Q4_K_M.gguf', 'Qwen-Q4_K_S.gguf'], 'Q4_K'), undefined);
  assert.equal(pickModelFile(['m-IQ4_0.gguf'], 'q4_0'), undefined);
});

test('ふだんの名前は、これまでどおり当てる（対）', () => {
  assert.equal(pickModelFile(['Qwen-Q4_K_M.gguf', 'Qwen-Q8_0.gguf'], 'q4_k_m'), 'Qwen-Q4_K_M.gguf');
  assert.equal(pickModelFile(['mistral-7b-instruct-v0.2.Q4_K_M.gguf'], 'q4_k_m'), 'mistral-7b-instruct-v0.2.Q4_K_M.gguf');
  assert.equal(pickModelFile(['Qwen-UD-Q4_K_M.gguf', 'Qwen-Q4_K_M.gguf'], 'q4_k_m'), 'Qwen-Q4_K_M.gguf');
});

test('持ち主の名前が blob でも、ファイルの場所へ直す', () => {
  assert.equal(hfFileUrl('https://huggingface.co/blob/repo/blob/main/x.gguf'), 'https://huggingface.co/blob/repo/resolve/main/x.gguf');
  assert.equal(hfFileUrl('https://huggingface.co/o/r/blob/main/x.gguf'), 'https://huggingface.co/o/r/resolve/main/x.gguf');
});
