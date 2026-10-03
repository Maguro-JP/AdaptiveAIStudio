/**
 * 同じプロセスで動くモデルも、上限で切れたら `length` で終える。
 *
 * ライブラリの `prompt()` は止まった理由を返さないので、上限（maxTokens）に届いても `stop` で終えていた。
 * 上の層は `stop` を「言い終えた」と読むので、切れた答えが完了になる。`promptWithMeta` の `stopReason` を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

/** 決めた理由で止まる偽のライブラリ。`meta` が false なら、止まった理由を返す口を持たない。 */
function fakeLib(stopReason: string, meta = true) {
  const answer = '途中まで';
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        o.onTextChunk?.(answer);
        return answer;
      }
      promptWithMeta = meta
        ? async (_text: string, o: { onTextChunk?: (t: string) => void } = {}) => {
          o.onTextChunk?.(answer);
          return { responseText: answer, stopReason };
        }
        : undefined;
    },
  });
}

async function ask(stopReason: string, stream: boolean, meta = true): Promise<string> {
  const dir = await tempDir('aas-inproc-cut-');
  await writeFile(join(dir, 'm.gguf'), 'GGUF');
  const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(stopReason, meta) });
  try {
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.gguf', stream, messages: [{ role: 'user', content: '長く説明して' }] }),
    });
    const raw = await res.text();
    if (!stream) return (JSON.parse(raw) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason;
    const reasons = [...raw.matchAll(/"finish_reason":"(\w+)"/g)].map((m) => m[1]);
    assert.equal(reasons.length, 1, `終わり方が一つではない: ${raw}`);
    return reasons[0]!;
  } finally {
    await rt.shutdown();
  }
}

describe('同じプロセスで動くモデルの終わり方', () => {
  test('上限で切れたら、流す道でも length', async () => {
    assert.equal(await ask('maxTokens', true), 'length');
  });
  test('上限で切れたら、まとめて返す道でも length', async () => {
    assert.equal(await ask('maxTokens', false), 'length');
  });
  test('言い終えたら stop（対）', async () => {
    assert.equal(await ask('eogToken', true), 'stop');
    assert.equal(await ask('eogToken', false), 'stop');
  });
  test('止まった理由を返す口が無いライブラリでは、今までどおり stop', async () => {
    assert.equal(await ask('maxTokens', true, false), 'stop');
  });
});
