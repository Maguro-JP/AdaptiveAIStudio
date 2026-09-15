
/**
 * 「これを使う」で選んだモデルは、その場で効く。
 *
 * 設定ファイルに書くだけで、動いている側には入れず、読んでいるものも
 * 降ろさなかった。画面は前のモデルを出したまま「立ち上げ直すと効きます」と言う
 * （Windows で実際にそうなった）。選んだら、表示が変わり、次の送信で選んだものを読む。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-choose-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
process.env.AAS_CONFIG = join(dir, 'aas.config.json');
const { UiServer } = await import('../src/ui/server.ts'); 
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('選んだモデルは、その場で効く', () => {
  test('表示が変わり、次の送信で選んだものを読む。立ち上げ直しは要らない', async () => {
    const models = await tempDir('aas-choose-models-');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    await writeFile(join(models, 'b.gguf'), 'GGUF');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const loadedPaths: string[] = [];
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async (o: { modelPath: string }) => {
          loadedPaths.push(o.modelPath);
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class {
        setChatHistory() {}
        async prompt(_t: string, o: { onTextChunk?: (t: string) => void } = {}) { o.onTextChunk?.('はい'); return 'はい'; }
      },
    });
    const s = new UiServer({
      port: 0, inprocLoad: load,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['a.gguf', 'b.gguf'] }],
        runtime: { kind: 'inproc', modelsDir: models, basePort: port, model: 'a.gguf' },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await s.start()).replace(/\/$/, ''); 
    const post = (p: string, body: unknown, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const answered = async (id: string) => {
      const m = await (await fetch(`${base}/api/conversations/messages?id=${id}`)).json() as { messages: { role: string }[] };
      return m.messages.filter((x) => x.role === 'assistant').length;
    };
    try {
      // まず a で 1ターン。
      const r1 = await (await post('/api/send', { text: 'x' })).json() as { conversationId: string };
      await until(async () => (await answered(r1.conversationId)) >= 1, 'a で答える', { timeoutMs: 20_000, everyMs: 100 });
      // 答えが残っても、その一言の後始末（やり残しの記録など）がまだ動いていることがある。手が空くまで待つ。
      await until(async () => ((await (await fetch(`${base}/api/conversations`)).json()) as { running: string | null }).running === null, '手が空く', { timeoutMs: 10_000, everyMs: 50 });
      assert.deepEqual(loadedPaths.map((p) => p.split(/[\\/]/).at(-1)), ['a.gguf']);

      // b を選ぶ。立ち上げ直しは要らず、表示はすぐ b。
      const r = await post('/api/config', { kind: 'inproc', modelsDir: models, model: 'b.gguf' }, 'PUT'); 
      const body = await r.json() as { restartNeeded: boolean; saved: { model: string } };
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(body.restartNeeded, false, '選んだだけで立ち上げ直しを求めている');
      const info = await (await fetch(`${base}/api/info`)).json() as { model: string };
      assert.equal(info.model, 'b.gguf', '表示が選んだものになっていない');

      // 次の送信で b を読む。
      const r2 = await (await post('/api/send', { text: 'y' })).json() as { conversationId: string };
      // 同じ会話に積まれるので、答えは二つ目。
      await until(async () => (await answered(r2.conversationId)) >= 2, 'b で答える', { timeoutMs: 20_000, everyMs: 100 });
      assert.deepEqual(loadedPaths.map((p) => p.split(/[\\/]/).at(-1)), ['a.gguf', 'b.gguf'], '選んだ b を読んでいない');
    } finally {
      await s.stop(); 
    }
  });
});
