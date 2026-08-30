/**
 * llama-server が落ちたときの見立て。
 *
 * 当てはめの語句は、**本物の llama-server を実際に落として採った**もの。
 * 検査もその出力（test/fixtures/llama/）をそのまま食わせる。
 * 一度は推測で書いて出しかけたが、動かしてみると外れていた
 * （口の取り合いは `bind: ` ではなく `couldn't bind HTTP server socket`）。
 * だから、ここは作り物の文字列で試さない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diagnose, describeFailure } from '../src/runtime/llama-diagnosis.ts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => readFile(join(here, 'fixtures', 'llama', `${name}.txt`), 'utf8');

const missingFile = await load('missing-file');
const badFormat = await load('bad-format');
const badArgument = await load('bad-argument');
const portTaken = await load('port-taken');
const missingLib = await load('missing-lib');

describe('本物の落ち方から見分ける', () => {
  test('モデルのファイルが無い', async () => {
    const d = diagnose(missingFile);
    assert.match(d.cause ?? '', /開けません/);
    assert.equal(d.verified, true);
  });

  test('中身が GGUF でない', async () => {
    const d = diagnose(badFormat);
    assert.match(d.cause ?? '', /GGUF ではありません/);
    assert.equal(d.verified, true);
  });

  test('「無い」と「中身が違う」を取り違えない', () => {
    // どちらも最後は「failed to load model」で終わる。
    // 決め手は途中の行にあり、順番を間違えると同じ答えになる。
    assert.notEqual(diagnose(missingFile).cause, diagnose(badFormat).cause);
  });

  test('知らない指定', () => {
    assert.match(diagnose(badArgument).cause ?? '', /理解できていません/);
  });

  test('口の取り合い', () => {
    // 推測では `bind: ` で当てようとしていた。実物は違う。
    assert.match(diagnose(portTaken).cause ?? '', /別のものが使っています/);
  });

  test('共有ライブラリを見失っている', () => {
    assert.match(diagnose(missingLib).cause ?? '', /共有ライブラリ/);
    assert.match(diagnose(missingLib).nextStep ?? '', /npm run llama/);
  });

  test('見覚えが無ければ、見立てを付けない', () => {
    assert.equal(diagnose('まったく知らない落ち方').cause, undefined);
  });
});

describe('人に見せる形', () => {
  test('生の出力を必ず添える', () => {
    const text = describeFailure(1, badFormat);
    assert.match(text, /終了コード 1/);
    assert.match(text, /invalid magic characters/, '生の出力が消えている');
    assert.match(text, /→ /);
  });

  test('実測でない見分けは、実測でないと言う', () => {
    // VRAM 不足はこちらの環境に GPU が無く、再現できていない。
    const text = describeFailure(1, 'ggml_backend_cuda_buffer_type_alloc: cudaMalloc failed: out of memory');
    assert.match(text, /メモリが足りません/);
    assert.match(text, /実物で確認できていません/, '推測を断定している');
  });

  test('実測のものには、その断りを付けない', () => {
    assert.doesNotMatch(describeFailure(1, portTaken), /確認できていません/);
  });

  test('分からないときは、分かったふりをしない', () => {
    const text = describeFailure(1, 'まったく未知の出力');
    assert.match(text, /まったく未知の出力/);
    assert.match(text, /見覚えのある落ち方ではありませんでした/);
  });
});

describe('決め手の行が捨てられていないか', () => {
  test('末尾5行では、原因を特定できる行が消える', () => {
    // これが元の実装だった。この試験は「なぜ20行に増やしたか」の記録。
    for (const out of [missingFile, badFormat]) {
      const tail5 = out.trim().split('\n').slice(-5).join('\n');
      assert.equal(diagnose(tail5).cause, 'モデルを読み込めませんでした。',
        '末尾5行でも原因が分かってしまうなら、この試験の前提が古い');
    }
  });

  test('20行あれば、原因まで分かる', () => {
    for (const [out, expected] of [[missingFile, /開けません/], [badFormat, /GGUF ではありません/]] as const) {
      const tail20 = out.trim().split('\n').slice(-20).join('\n');
      assert.match(diagnose(tail20).cause ?? '', expected);
    }
  });
});
