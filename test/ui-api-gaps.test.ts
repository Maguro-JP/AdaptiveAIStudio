/**
 * 画面の本体の口の不具合（42 回目の調査）。
 *
 * - 別のタブで消した会話へ切り替えない（打った分が消した会話の行き先へ書かれ、片づけで消えていた）
 * - 無い会話の見出しの付け替えは 404 で、ファイルの道を返さない
 * - 出来事の流れは GET だけで開く。止めた後には開かない
 * - 使うモデルの名前に `..` を受けない
 * - `.env` への同時の書き込みで、片方の行を消さない
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { until } from './until.ts';
import { writeEnvValue, parseEnvFile } from '../src/core/env.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-ui-api-gaps-');
process.env.AAS_CONFIG = join(await tempDir('aas-ui-api-gaps-config-'), 'aas.config.json');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let server: InstanceType<typeof UiServer>;
let base = '';

before(async () => {
  fake = await startFakeServer({ kind: 'stream', text: 'はい' });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 流れなど */ }
  return { status: r.status, body: parsed };
}

describe('消した会話', () => {
  test('**別のタブで消した会話へは切り替えない**（404 で、消されたと言う）', async () => {
    const sent = await call('POST', '/api/send', { text: 'はじめ', conversationId: null });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const id = sent.body.conversationId as string;
    await until(async () => {
      const r = await fetch(`${base}/api/conversations/messages?id=${id}`);
      const j = await r.json() as { messages?: Array<{ role: string }> };
      return (j.messages ?? []).some((m) => m.role === 'assistant');
    }, '一回目が終わらない');
    // トップへ戻ってから消す（見ている会話は消せないので）
    await call('POST', '/api/conversations');
    // 答えが残ってから作業の終わり（#runningId が外れる）までに間がある。遅い機械（Windows の CI）ではその間に消しに行き、
    // 「作業中」の 409 で落ちた。作業中のあいだは待ってから消す
    let removed = { status: 0, body: {} as Record<string, unknown> };
    await until(async () => {
      removed = await call('DELETE', `/api/conversations?id=${id}`);
      return removed.status !== 409;
    }, '作業が終わらない');
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const selected = await call('POST', '/api/conversations/select', { id });
    assert.equal(selected.status, 404, `消した会話へ切り替えた: ${JSON.stringify(selected.body)}`);
    assert.equal(selected.body.gone, true);
  });

  test('**無い会話の見出しの付け替えは 404 で、ファイルの道を返さない**', async () => {
    const r = await call('POST', '/api/conversations/title', { id: 'abcdef123', title: 'x' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.doesNotMatch(String(r.body.error), /[\\/]/, `道を返した: ${r.body.error}`);
  });
});

describe('出来事の流れ', () => {
  test('**GET 以外では開かない**', async () => {
    const r = await call('POST', '/api/events');
    assert.equal(r.status, 405);
  });
});

describe('使うモデルの名前', () => {
  for (const model of ['..', '.', ' . ']) {
    test(`**${JSON.stringify(model)} を受けない**（保存先の外を指す）`, async () => {
      const r = await call('PUT', '/api/config', { kind: 'inproc', model });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(String(r.body.error), /モデル/, JSON.stringify(r.body));
    });
  }
});

describe('.env への書き込み', () => {
  test('**同時に二つ書いても、両方の行が残る**', async () => {
    const dir = await tempDir('aas-ui-api-env-');
    const path = join(dir, '.env');
    await writeFile(path, 'KEEP=1\n');
    await Promise.all([
      writeEnvValue(path, 'FIRST_TOKEN', 'aaa'),
      writeEnvValue(path, 'SECOND_TOKEN', 'bbb'),
      writeEnvValue(path, 'THIRD_TOKEN', 'ccc'),
    ]);
    const got = parseEnvFile(await readFile(path, 'utf8'));
    assert.equal(got.KEEP, '1');
    assert.equal(got.FIRST_TOKEN, 'aaa');
    assert.equal(got.SECOND_TOKEN, 'bbb');
    assert.equal(got.THIRD_TOKEN, 'ccc');
  });
});
