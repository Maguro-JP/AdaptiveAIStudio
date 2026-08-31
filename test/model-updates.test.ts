/**
 * 新しいモデルが出ていないかを見に行く部分の検査。
 *
 * ローカルで動かす以上、古いものを使い続ける理由が無い。
 * ただし乗り換えの起点が「カタログを書いた人が書き換える」だけだと、
 * 書いた人が古くなった時点で止まる（実際に二度止まった）。
 * だから配布元に訊く。ここはその問い方の検査。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitRef, nextFamilies, findNewerOllama, findRecentGguf, describeNewer,
} from '../src/runtime/model-updates.ts';

describe('名前の分解', () => {
  test('家族と札に分ける', () => {
    assert.deepEqual(splitRef('qwen3.5:9b'), { family: 'qwen3.5', tag: '9b' });
    assert.deepEqual(splitRef('qwen3.6:35b-a3b-coding-nvfp4'), {
      family: 'qwen3.6', tag: '35b-a3b-coding-nvfp4',
    });
    assert.deepEqual(splitRef('gemma3'), { family: 'gemma3' });
  });
});

describe('次の世代の見当', () => {
  test('小数の世代は、その次から', () => {
    const next = nextFamilies('qwen3.5');
    assert.equal(next[0], 'qwen3.6');
    assert.ok(next.includes('qwen3.8'), next.join(','));
    assert.ok(next.includes('qwen4'), '整数の次を見ていない');
    assert.ok(!next.includes('qwen3.5'), '自分自身を候補にしている');
    assert.ok(!next.includes('qwen3.4'), '古い方を候補にしている');
  });

  test('整数の世代は、小数から', () => {
    const next = nextFamilies('qwen3');
    assert.equal(next[0], 'qwen3.1');
    assert.ok(next.includes('qwen4'));
  });

  test('問い合わせすぎない', () => {
    assert.ok(nextFamilies('qwen3', 3).length <= 3);
  });

  test('世代の付いていない名前は、当てに行かない', () => {
    // 当てずっぽうで無関係な名前を叩きに行かないこと
    assert.deepEqual(nextFamilies('gemma'), []);
    assert.deepEqual(nextFamilies('mistral-small'), []);
  });
});

describe('Ollama へ訊く', () => {
  /** 指定した名前だけ「ある」と答える偽の配布元。 */
  function registry(exists: string[]) {
    const asked: string[] = [];
    const impl = (async (url: string | URL) => {
      const u = String(url);
      asked.push(u);
      return exists.some((e) => u.includes(`/library/${e}/`))
        ? new Response('{"tags":[]}')
        : new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    return { impl, asked };
  }

  test('新しい世代があれば見つける', async () => {
    const { impl } = registry(['qwen3.6', 'qwen3.8']);
    const found = await findNewerOllama({ installed: ['qwen3.5:9b'], fetchImpl: impl });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.current, 'qwen3.5');
    assert.deepEqual(found[0]?.found, ['qwen3.6', 'qwen3.8']);
  });

  test('無ければ、何も言わない', async () => {
    const { impl } = registry([]);
    assert.deepEqual(await findNewerOllama({ installed: ['qwen3.5:9b'], fetchImpl: impl }), []);
  });

  test('同じ家族を二度訊かない', async () => {
    const { impl, asked } = registry([]);
    await findNewerOllama({ installed: ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:27b'], fetchImpl: impl });
    const families = new Set(asked.map((u) => u.split('/library/')[1]?.split('/')[0]));
    assert.equal(asked.length, families.size, '同じ問い合わせを繰り返している');
  });

  test('繋がらないときは、分かった分だけ返す', async () => {
    // 「繋がらない」と「新しいものが無い」を混同しない
    let calls = 0;
    const flaky = (async (url: string | URL) => {
      calls += 1;
      if (calls === 1) return new Response('{"tags":[]}');
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const found = await findNewerOllama({ installed: ['qwen3.5:9b'], fetchImpl: flaky });
    assert.deepEqual(found[0]?.found, ['qwen3.6'], '途中で落ちた分まで無かったことにしている');
  });
});

describe('Hugging Face へ訊く', () => {
  test('よく使われている順で訊く', async () => {
    let asked = '';
    const impl = (async (url: string | URL) => {
      asked = String(url);
      return Response.json([
        { id: 'unsloth/Qwen3.6-35B-A3B-GGUF', downloads: 900, lastModified: '2026-08-20' },
      ]);
    }) as unknown as typeof fetch;

    const out = await findRecentGguf({ query: 'qwen', fetchImpl: impl });
    assert.match(asked, /sort=downloads/);
    assert.match(asked, /filter=gguf/);
    assert.equal(out[0]?.id, 'unsloth/Qwen3.6-35B-A3B-GGUF');
  });

  test('答えが配列でなくても壊れない', async () => {
    const impl = (async () => Response.json({ error: 'x' })) as unknown as typeof fetch;
    assert.deepEqual(await findRecentGguf({ query: 'q', fetchImpl: impl }), []);
  });

  test('断られたら、その番号を言う', async () => {
    const impl = (async () => new Response('x', { status: 429 })) as unknown as typeof fetch;
    await assert.rejects(findRecentGguf({ query: 'q', fetchImpl: impl }), /\(429\)/);
  });
});

describe('人に見せる形', () => {
  test('新しい＝載る、ではないと断る', () => {
    const text = describeNewer([{ current: 'qwen3.5', found: ['qwen3.6'] }]);
    assert.match(text, /qwen3\.5 → qwen3\.6/);
    assert.match(text, /新しい＝この機械で動く、ではありません/);
  });

  test('無ければ、そう言う', () => {
    assert.match(describeNewer([]), /見つかりませんでした/);
  });
});
