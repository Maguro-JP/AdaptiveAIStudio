/**
 * いま動かしているモデルを、画面の足元に出す。
 *
 * **撮って見つけた。**答えの札には `local:local-model` と出ているのに、
 * 横の一覧の足元は「ollama · —」のままだった。設定で固定していなければ
 * 名前は答えてみるまで決まらない（速い方へ乗り換える作り）ので、分からない
 * ものとして「—」を出していた。**答えたのなら、もう分かっている。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-info-model-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('足元に、いま動かしているモデルを出す', () => {
  test('**答えたあとは、答えたモデルの名前が出る**', async () => {
    const root = await tempDir('aas-info-model-root-');
    const fake = await startFakeServer({ kind: 'stream', text: 'はい。\nTASK_DONE\n' });
    const s = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        // 固定しない（ollama は依頼ごとに選ぶ）。ここが「—」になっていた形。
        runtime: { kind: 'ollama' },
        agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, approval: 'auto', root },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await s.start()).replace(/\/$/, '');
    const info = async () => (await (await fetch(`${base}/api/info`)).json()) as { model: string };
    try {
      const sent = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'こんにちは' }),
      });
      assert.equal(sent.status, 202, await sent.text());
      // 答え終わるまで待つ（答えたモデルは、終わりの合図に乗ってくる）。
      await until(async () => (await info()).model !== '—', 'モデルの名前が出る', { timeoutMs: 40_000 });
      assert.equal((await info()).model, 'local:m', '答えたモデルの名前になっていない');
    } finally { await s.stop(); await fake.close(); }
  });
});
