/**
 * 画面の本体の口の中盤の不具合（63 回目の調査）。
 *
 * - やり残しと段取りの記録が読めないと、空の一覧を返し、画面は「やり残しなし」と見せた
 *
 * 読めないフォルダを開くと根の一覧にすり替えた件は、root で走らせると権限が効かず、走らせる場所で結果が変わるので試験を書いていない。
 * 支度の間の「立ち上げ直す」・会話を消す件は遅らせる読み込みが、承認の「以降訊かない」の件はコマンドと書き込みを順に出す偽物が要るので、
 * 試験を書いていない（確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-server-mid-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('**やり残しと段取りの記録が読めないとき、そう言う**', async () => {
  // 記録の場所にフォルダを置く（読むと EISDIR。在るが読めない）
  await mkdir(join(dir, 'state', 'unfinished.jsonl'), { recursive: true });
  await mkdir(join(dir, 'state', 'goals.jsonl'), { recursive: true });
  const fake = await startFakeServer({ kind: 'echo' });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  try {
    const unfinished = await (await fetch(`${base}/api/unfinished`)).json() as { error?: string };
    assert.ok(unfinished.error, 'やり残しが読めないのに言っていない');
    const goals = await (await fetch(`${base}/api/goals`)).json() as { error?: string };
    assert.ok(goals.error, '段取りが読めないのに言っていない');
  } finally {
    await server.stop();
    await fake.close();
  }
});
