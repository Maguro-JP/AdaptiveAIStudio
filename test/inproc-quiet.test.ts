/**
 * 黙っている間も、生きていると言い続ける。
 *
 * 中で読む口は、入力を読んでいる間 `: working` を打って「生きている」と伝える。
 * **最初の 1 トークンが出た時点で、打つのをやめていた。**
 *
 * ツールの呼び出しを組んでいる間は本文が一文字も出ない。遅い機械ではそこから
 * 何分も黙るので、送り側はその無音を停滞と読んで落とす。Windows のランナーで
 * 本物の重み（Qwen3-0.6B）を読ませたとき、足し算は通り、ツールを渡した回だけ
 * 「120秒 応答しませんでした（停滞）」で落ちた。**動いていたのに落としている。**
 *
 * ここでは、**最初の本文の後に来た無音でも合図が出ること**を留める。
 * 送り側で受ける方は `test/quiet-alive.test.ts`。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

const BEAT = 60;

/**
 * 本文を一つ出し、`quietMs` 黙ってからツールを呼ぶ偽のライブラリ。
 * 実機で起きた並び（本文 → 長い無音 → ツール）をそのまま作る。
 */
function fakeLib(quietMs: number) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      chatWrapper = { wrapperName: 'QwenChatWrapper' };
      setChatHistory() {}
      async prompt(_text: string, o: {
        onTextChunk?: (t: string) => void;
        // **本物はこちらも呼ぶ。**呼ばないモックで書いたら、直しを元へ戻しても通った
        // （合図を止める判断はこちらで起きるため）。モックは、見る所を通す形にする。
        onResponseChunk?: (c: { type?: string; text: string; tokens?: unknown[] }) => void;
        functions?: Record<string, { handler: (a: unknown) => unknown }>;
      } = {}) {
        // 考えごとを 0 にしてあるので、実機でも最初に出たのは空白一つだった。
        o.onResponseChunk?.({ text: ' ', tokens: [1] });
        o.onTextChunk?.(' ');
        await sleep(quietMs);
        await o.functions?.read_file?.handler({ path: 'secret.txt' });
        return '';
      }
    },
  });
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'ファイルを読む',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}];

describe('黙っている間も、生きていると言う', () => {
  test('**最初の本文の後に黙っても、合図を打ち続ける**', async () => {
    const dir = await tempDir('aas-quiet-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    // 無音は合図の 5 倍。打ち続けていなければ、ここに一つも出ない。
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, queueHeartbeatMs: BEAT, load: fakeLib(BEAT * 5),
    });
    try {
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'secret.txt を読んで' }],
        }),
      });
      const raw = await res.text();
      // 本文（空白）が出た後に、合図が在ること。**順番で見る。**
      // 全体に在るかだけを見ると、入力を読んでいる間の分で通ってしまう。
      const firstData = raw.indexOf('"content":" "');
      assert.ok(firstData >= 0, `本文が出ていない: ${raw.slice(0, 200)}`);
      const beatAfter = raw.indexOf(': working', firstData);
      assert.ok(beatAfter > firstData, `本文の後に合図が無い（黙ったまま）: ${JSON.stringify(raw)}`);
      // ツールの呼び出しまで届いていること（落ちていない）。
      assert.match(raw, /read_file/);
    } finally { await rt.shutdown(); }
  });

  test('黙っていないなら、合図は要らない（対）', async () => {
    const dir = await tempDir('aas-quiet-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    // 無音は合図より短い。打つ必要が無いので、余計な合図を出さない。
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, queueHeartbeatMs: BEAT * 20, load: fakeLib(1),
    });
    try {
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'secret.txt を読んで' }],
        }),
      });
      const raw = await res.text();
      const firstData = raw.indexOf('"content":" "');
      assert.ok(firstData >= 0, `本文が出ていない: ${raw.slice(0, 200)}`);
      assert.equal(raw.indexOf(': working', firstData), -1, `黙っていないのに合図を打っている: ${JSON.stringify(raw)}`);
    } finally { await rt.shutdown(); }
  });
});
