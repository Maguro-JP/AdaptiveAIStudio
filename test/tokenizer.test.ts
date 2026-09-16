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

/**
 * 数え方を、窓の勘定に繋いだところ。
 *
 * **繋がっていなければ、字句器は作っただけで何もしていない。**
 * ここでは繋ぎ目だけを見る（本物と同じ数になるかは conformance の側）。
 */
describe('窓の勘定に繋がっている', () => {
  test('トークンで測って切る。文字数と混ぜない', async () => {
    const { cutToTokens } = await import('../src/agent/window.ts');
    // 1文字=1トークンと数える人。予算10なら10文字まで。
    const one = (t: string) => [...t].length;
    const text = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n');
    const cut = cutToTokens(text, 10, one);
    assert.ok(one(cut) <= 10, `予算を超えている: ${one(cut)}`);
    // 行の途中では切らない。
    assert.ok(!cut.endsWith('行'), `行の途中で切れている: ${JSON.stringify(cut)}`);
    // 数え方が変われば、切れる量も変わる（混ぜていない証拠）。
    const four = (t: string) => Math.ceil([...t].length / 4);
    assert.ok(cutToTokens(text, 10, four).length > cut.length, '数え方を見ていない');
  });

  test('収まるものは切らない', async () => {
    const { cutToTokens } = await import('../src/agent/window.ts');
    assert.equal(cutToTokens('短い', 100), '短い');
    assert.equal(cutToTokens('なんでも', 0), '', '予算0なら何も返さない');
  });

  test('道具の返しが、渡した数え方で切られる', async () => {
    const { readFileTool } = await import('../src/agent/tools/fs.ts');
    const { writeFile } = await import('node:fs/promises');
    const { tempDir } = await import('./tmp.ts');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-count-cut-');
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));

    const base = { root: dir, signal: new AbortController().signal, contextTokens: 4096 };
    // 1文字=1トークンと数える人の方が、たくさん食うので早く切れる。
    const greedy = await readFileTool.run({ path: 'a.txt' }, {
      ...base, count: (t: string) => [...t].length,
    } as never);
    const thrifty = await readFileTool.run({ path: 'a.txt' }, {
      ...base, count: (t: string) => Math.ceil([...t].length / 4),
    } as never);
    assert.ok(greedy.content.length < thrifty.content.length, '数え方を見ていない');
    // 行の切れ目で切れたときは、**続きの取り方まで言う**（offset を出す）。
    // 「この先は search_text で」しか言えなかった頃は、続きを読む道が無かった。
    assert.match(greedy.content, /続きは offset=\d+ で読めます/, '続きの取り方を言っていない');
  });
});

/**
 * どう数えるかの決め方は、一箇所にだけ書く。
 *
 * 会話の土台と点検（doctor）で別々に決めていると、片方だけ直して食い違う。
 * **見積もりに戻ったときは、戻った理由まで言う。**言わないと、
 * 切れ方がおかしいときに「モデルが悪い」としか言えない。
 */
describe('数え方の決め方', () => {
  test('この中で読む道でなければ、見積もり。理由も言う', async () => {
    const { resolveCounting } = await import('../src/core/counting.ts');
    const got = await resolveCounting({ runtime: { kind: 'ollama' } } as never);
    assert.equal(got.counter, undefined);
    assert.ok(got.why.includes('見積もり'), got.why);
  });

  test('GGUF が無ければ、見積もり', async () => {
    const { resolveCounting } = await import('../src/core/counting.ts');
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-counting-none-');
    const got = await resolveCounting({ runtime: { kind: 'inproc', modelsDir: dir } } as never);
    assert.equal(got.counter, undefined);
    assert.ok(got.why.includes('ありません'), got.why);
  });

  test('**複数あっても、土台が読むのと同じものを見る**', async () => {
    /*
     * 前は「決められないなら見積もりに戻す」にしていた。当てずっぽうに
     * 選ぶくらいなら粗いほうがまし、という理屈で、それは**選び方が
     * 決まっていなかったとき**は正しい。
     *
     * いまは決まっている。土台は「設定で決めた名前、無ければ置き場の
     * 最初の一つ」を読む。**同じ順で見れば、当てずっぽうではない。**
     * 二つ置いてあるだけで見積もりに落ちる方が損。
     */
    const { resolveCounting } = await import('../src/core/counting.ts');
    const { tempDir } = await import('./tmp.ts');
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-counting-many-');
    for (const name of ['b.gguf', 'a.gguf']) {
      execFileSync(process.execPath, ['scripts/tiny-gguf.mjs', join(dir, name)], { stdio: 'pipe' });
    }
    const got = await resolveCounting({ runtime: { kind: 'inproc', modelsDir: dir } } as never);
    assert.ok(got.counter, `見積もりに落ちている: ${got.why}`);
    assert.equal(got.file, 'a.gguf', '置き場の最初の一つを見ていない');
  });

  test('設定で名前が決まっていれば、そちらを見る', async () => {
    const { resolveCounting } = await import('../src/core/counting.ts');
    const { tempDir } = await import('./tmp.ts');
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-counting-named-');
    for (const name of ['a.gguf', 'b.gguf']) {
      execFileSync(process.execPath, ['scripts/tiny-gguf.mjs', join(dir, name)], { stdio: 'pipe' });
    }
    const got = await resolveCounting(
      { runtime: { kind: 'inproc', modelsDir: dir, model: 'b.gguf' } } as never,
    );
    assert.equal(got.file, 'b.gguf', '設定で決めた名前を見ていない');
  });

  test('読めない GGUF なら、見積もりに戻る（落ちない）', async () => {
    const { resolveCounting } = await import('../src/core/counting.ts');
    const { tempDir } = await import('./tmp.ts');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-counting-bad-');
    await writeFile(join(dir, 'broken.gguf'), 'これは GGUF ではありません');
    const got = await resolveCounting({ runtime: { kind: 'inproc', modelsDir: dir } } as never);
    assert.equal(got.counter, undefined);
    assert.ok(got.why.includes('broken.gguf'), got.why);
  });
});
