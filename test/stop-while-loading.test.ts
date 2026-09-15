/**
 * 読み込みの最中に画面を止めても、裏で口を立て直さない。
 *
 * 送った直後に stop() すると、読み終えた側がセッションを作り直して
 * inproc の口を開き、止めたはずのプロセスが生き続けた
 * （テストの走りが終わらないことで見つけた）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-stop-load-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('読み込みの最中に止める', () => {
  test('読み終えても、口を開き直さない', async () => {
    const servers = () => process.getActiveResourcesInfo().filter((x) => x === 'TCPServerWrap').length;
    // 口の数は、何も開く前に数える。閉じた直後は、まだ数に残ることがある。
    const before = servers();
    const models = await tempDir('aas-stop-load-models-');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let loaded = false;
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => {
          await gate;
          loaded = true;
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
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
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'こんにちは' }),
    });
    assert.equal(r.status, 202);
    await s.stop();
    release();
    await until(() => loaded, '読み終える');
    // 読み終えた側が何かするなら、この直後。起きるまで見るのではなく、
    // 「起きない」ことを、口の数が戻っているかで見る。
    await until(() => servers() === before, '口が閉じる', { timeoutMs: 5000 }).catch(() => undefined);
    try {
      assert.equal(servers(), before, '止めたあとに口が開いている（プロセスが終わらない）');
    } finally {
      // 壊れていたら口が開いている。もう一度止めてから抜ける（閉じないと走りが終わらない）。
      await s.stop();
    }
  });
});
