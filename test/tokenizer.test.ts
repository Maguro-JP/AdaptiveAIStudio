/**
 * 本物の数え方の検査。
 *
 * ここでは**筋が通っているか**だけを見る。本物と同じかどうかは、
 * 同じ GGUF を llama.cpp にも読ませて突き合わせる
 * （`scripts/tokenizer-conformance.mjs`。`npm run check` の中で回る）。
 * ここで「本物と同じ」を主張しない。突き合わせていないので。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vocabFrom, tokenizerFor, type VocabSpec } from '../src/agent/tokenizer.ts';

function md(entries: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(entries));
}

describe('数え方を取り出す', () => {
  test('要るものが無ければ、作らない', () => {
    assert.equal(vocabFrom(md({})), undefined);
    assert.equal(vocabFrom(md({ 'tokenizer.ggml.model': 'gpt2' })), undefined, '語彙が無いのに作っている');
  });

  test('知らない数え方には、当てずっぽうを返さない', () => {
    const spec: VocabSpec = { model: 'rwkv', tokens: ['a'] };
    assert.equal(tokenizerFor(spec), undefined, '知らないのに作っている');
  });

  test('BPE で merges が無ければ、作らない', () => {
    // merges 無しで BPE を名乗るものは壊れている。黙って1文字ずつ数えない。
    assert.equal(tokenizerFor({ model: 'gpt2', tokens: ['a', 'b'] }), undefined);
  });
});

/** GPT-2 の写しでは、空白は Ġ になる。 */
const G = 'Ġ';

describe('BPE の数え方', () => {
  const spec: VocabSpec = {
    model: 'gpt2',
    tokens: [],
    merges: ['t h', 'th e', `${G} the`],
  };
  const tk = tokenizerFor(spec)!;

  test('繋がるものは繋がる', () => {
    assert.equal(tk.count('the'), 1);
    assert.equal(tk.count(' the'), 1, '空白ごと繋がるはず');
  });

  test('繋がらないものは、バイトのまま', () => {
    assert.equal(tk.count('xyz'), 3);
    // 多バイトの字は、バイトの数だけになる。
    assert.equal(tk.count('あ'), 3);
  });

  test('先に書いた繋ぎ方から使う', () => {
    // t h → th、th e → the の順でしか the に届かない。
    assert.equal(tk.count('the the'), 2);
  });

  test('空なら 0', () => {
    assert.equal(tk.count(''), 0);
  });
});

describe('SPM の数え方', () => {
  const tokens = ['<unk>', '▁', '▁t', 'he', '▁the', 'a', 'b', 'ab'];
  const spec: VocabSpec = { model: 'llama', tokens, scores: tokens.map((_, i) => i) };
  const tk = tokenizerFor(spec)!;

  test('点数の高い方から繋ぐ', () => {
    // ▁the が語彙にあるので、一つで済む。
    assert.equal(tk.count('the'), 1);
  });

  test('語彙に無い字は、バイトに落ちる', () => {
    // 「あ」は3バイト。落ちた分だけ数が増える。
    assert.ok(tk.count('あ') >= 3, `落ちた分を数えていない: ${tk.count('あ')}`);
  });

  test('空なら 0', () => {
    assert.equal(tk.count(''), 0);
  });
});
