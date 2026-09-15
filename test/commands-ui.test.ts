/**
 * 打ち込みのコマンドが、画面の口を通ること。
 *
 * `/api/commands` が組み込みと作業場の skill を返し、`/api/send` は
 * `/名前` を指示に置き換えてモデルへ渡す。知らない名前は 400 で断る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-cmd-ui-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('打ち込みのコマンド', () => {
  test('/名前 は指示に置き換わってモデルへ届き、知らない名前は断る', async () => {
    const models = await tempDir('aas-cmd-models-');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    const work = await tempDir('aas-cmd-work-');
    await mkdir(join(work, '.claude', 'skills', 'deploy'), { recursive: true });
    await writeFile(join(work, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: 配る手順\n---\n配る前にテストを通す。\n\n$ARGUMENTS\n');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const asked: string[] = [];
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) }),
      }),
      LlamaChatSession: class {
        setChatHistory() {}
        async prompt(t: string, o: { onTextChunk?: (t: string) => void } = {}) {
          asked.push(t);
          o.onTextChunk?.('はい');
          return 'はい';
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
        agent: { root: work, approval: 'auto' },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const url = (await s.start()).replace(/\/$/, "");
    try {
      const list = await fetch(`${url}/api/commands`).then((r) => r.json()) as { commands: { name: string; source: string; path?: string }[] };
      const names = list.commands.map((c) => c.name);
      assert.ok(names.includes('fix') && names.includes('deploy'), `組み込みと skill が並んでいない: ${names.join(',')}`);
      assert.equal(list.commands.find((c) => c.name === 'deploy')?.source, 'skill');

      const bad = await fetch(`${url}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '/fxi これ' }),
      });
      assert.equal(bad.status, 400);
      const why = (await bad.json() as { error: string }).error;
      assert.match(why, /\/fxi/);
      assert.match(why, /\/fix/);

      const ok = await fetch(`${url}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '/deploy 本番へ' }),
      });
      assert.equal(ok.status, 202);
      await until(() => asked.some((t) => t.includes('配る前にテストを通す。\n\n本番へ')), '置き換えた指示がモデルへ届く', { timeoutMs: 15000 });
      assert.ok(!asked.some((t) => t.includes('/deploy')), '打った形のままモデルへ渡している');
    } finally {
      await s.stop();
    }
  });
});
