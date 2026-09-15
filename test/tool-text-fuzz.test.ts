/**
 * 切れ端の切れ目が変わっても、同じものが出る。
 *
 * モデルは文字を少しずつ流してくる。**切れ目はこちらで選べない。**
 * 呼び出しの記述が切れ目をまたいだときに拾えなければ、生の JSON が
 * そのまま画面に出るか、逆に本文が消える。どちらも起きたことがある。
 *
 * 手で選んだ切れ目で試すと、通るものを選んだのと区別が付かない。
 * **種を固定した無作為で、同じ文をいろいろな切れ目で流す。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolTextFilter, extractToolCalls } from '../src/agent/tool-text.ts';

function makeRandom(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 一息で流したときの結果。これを正とする。 */
function whole(text: string): { shown: string; calls: unknown[] } {
  const f = new ToolTextFilter();
  const shown = f.push(text);
  const rest = f.end();
  return { shown: shown + rest.text, calls: rest.calls };
}

/** 無作為な切れ目で流したときの結果。 */
function chunked(text: string, rand: () => number): { shown: string; calls: unknown[] } {
  const f = new ToolTextFilter();
  let shown = '';
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(rand() * 12);
    shown += f.push(text.slice(at, at + size));
    at += size;
  }
  const rest = f.end();
  return { shown: shown + rest.text, calls: rest.calls };
}

/** それらしい流れを作る。呼び出しの記述を混ぜたり混ぜなかったり。 */
function sample(rand: () => number): string {
  const parts: string[] = [];
  const rounds = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < rounds; i += 1) {
    parts.push(['読みます。', 'これから直します。\n', '説明: ', 'はい。'][Math.floor(rand() * 4)]!);
    if (rand() < 0.5) {
      const name = ['read_file', 'edit_file', 'search_text'][Math.floor(rand() * 3)]!;
      const shape = Math.floor(rand() * 3);
      if (shape === 0) {
        parts.push(`{"name":"${name}","arguments":{"path":"a${i}.ts"}}`);
      } else if (shape === 1) {
        parts.push(`\n\`\`\`json\n{"name": "${name}", "arguments": {"path": "b${i}.ts"}}\n\`\`\`\n`);
      } else {
        parts.push(`<tool_call>{"name":"${name}","arguments":{"path":"c${i}.ts"}}</tool_call>`);
      }
    }
  }
  return parts.join('');
}

describe('切れ目が変わっても、同じものが出る', () => {
  test('**一息で流したときと、細切れで流したときが一致する**', () => {
    const rand = makeRandom(20260906);
    let withCalls = 0;
    for (let round = 0; round < 400; round += 1) {
      const text = sample(rand);
      const a = whole(text);
      const b = chunked(text, rand);
      assert.equal(b.shown, a.shown, `見せる本文が違う（${round} 回目）: ${JSON.stringify(text)}`);
      assert.deepEqual(b.calls, a.calls, `拾った呼び出しが違う（${round} 回目）: ${JSON.stringify(text)}`);
      if (a.calls.length > 0) withCalls += 1;
    }
    // **呼び出しが一つも無い流ればかりだと、この検査は何も見ていない。**
    assert.ok(withCalls > 100, `呼び出しを含む流れが少なすぎる: ${withCalls}/400`);
  });

  test('生の呼び出しを、そのまま画面へ出さない', () => {
    const rand = makeRandom(777);
    for (let round = 0; round < 200; round += 1) {
      const text = sample(rand);
      const got = chunked(text, rand);
      if (extractToolCalls(text).calls.length === 0) continue;
      assert.ok(
        !/"arguments"\s*:/.test(got.shown),
        `生の呼び出しが本文に出ている（${round} 回目）: ${got.shown.slice(0, 120)}`,
      );
    }
  });

  test('呼び出しが無い文は、一字も欠けない', () => {
    const rand = makeRandom(999);
    for (let round = 0; round < 200; round += 1) {
      const text = ['ふつうの返事です。', '直しました。\n次はこれです。', 'はい', ''][
        Math.floor(rand() * 4)
      ]! + 'あ'.repeat(Math.floor(rand() * 50));
      assert.equal(chunked(text, rand).shown, text, `本文が欠けている: ${JSON.stringify(text)}`);
    }
  });
});
