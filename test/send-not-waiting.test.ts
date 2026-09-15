/**
 * 送った返り（202）は、モデルの読み込みを待たない。
 *
 * 返事を返す前に読んでいたので、CPU で本物を読む機械では送った側が
 * 60 秒で時間切れになった（Windows の smoke で落ちた）。受け取ってから裏で読む。
 * 読み込みの側は「202 が届いてから」でないと終わらないようにしてある。
 * 送りが読み込みを待つ作りなら、ここは互いに待って上限で落ちる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-send-wait-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('送った返りは、読み込みを待たない', () => {
  test('202 が先に返り、読み込みはその後。答えは届く', async () => {
    const models = await tempDir('aas-send-wait-models-');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    let accepted = false;
    let loadedAfterAccept: boolean | undefined;
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => {
          // 202 が届くまで読み終わらない。
          await until(() => accepted, '202 が届く', { timeoutMs: 8000, everyMs: 20 });
          loadedAfterAccept = accepted;
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class {
        setChatHistory() {}
        async prompt(_t: string, o: { onTextChunk?: (t: string) => void } = {}) {
          for (const ch of [...'読んでから答えた']) o.onTextChunk?.(ch);
          return '読んでから答えた';
        }
      },
    });
    const s = new UiServer({
      port: 0, inprocLoad: load,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['a.gguf'] }],
        candidates: ['local:a.gguf'],
        runtime: { kind: 'inproc', modelsDir: models, basePort: port },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'あいさつして' }), signal: AbortSignal.timeout(10_000),
      });
      const body = await r.json() as { accepted?: boolean; loading?: boolean; conversationId?: string };
      assert.equal(r.status, 202, JSON.stringify(body));
      assert.equal(body.loading, true, '読み込みが要ることを言っていない');
      accepted = true;
      await until(async () => {
        const m = await (await fetch(`${base}/api/conversations/messages?id=${body.conversationId}`)).json() as { messages: { role: string; content: string }[] };
        return m.messages.some((x) => x.role === 'assistant' && x.content.includes('読んでから答えた'));
      }, '答えが会話に残る', { timeoutMs: 20_000, everyMs: 100 });
      assert.equal(loadedAfterAccept, true, '202 の前に読み終わっている');
    } finally {
      await s.stop();
    }
  });
});
