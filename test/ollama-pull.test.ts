/**
 * Ollama にモデルを取ってこさせる部分の検査。
 *
 * 進み具合は NDJSON（1行1件）で流れてくる。
 * **途中で失敗を流してくることがある**ので、
 * 最後まで読めたことを成功と取り違えないかを重点的に見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pullModel, nativeBase } from '../src/runtime/ollama-pull.ts';

/** NDJSON を流す偽の口。 */
function fakeOllama(lines: unknown[], opts: { status?: number } = {}) {
  const seen: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    if (opts.status && opts.status !== 200) return new Response('x', { status: opts.status });
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    return new Response(text);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const OK = [
  { status: 'pulling manifest' },
  { status: 'downloading', total: 1000, completed: 500 },
  { status: 'downloading', total: 1000, completed: 1000 },
  { status: 'success' },
];

describe('口の場所', () => {
  test('/v1 を落として native の口にする', () => {
    assert.equal(nativeBase('http://localhost:11434/v1'), 'http://localhost:11434');
    assert.equal(nativeBase('http://localhost:11434/v1/'), 'http://localhost:11434');
    assert.equal(nativeBase('http://localhost:11434'), 'http://localhost:11434');
  });
});

describe('Ollama への依頼', () => {
  test('名前を渡して、最後まで取れる', async () => {
    const { impl, seen } = fakeOllama(OK);
    await pullModel({ baseUrl: 'http://x/v1', ref: 'qwen2.5-coder:7b', fetchImpl: impl });

    assert.equal(seen[0]?.url, 'http://x/api/pull');
    assert.deepEqual(seen[0]?.body, { model: 'qwen2.5-coder:7b', stream: true });
  });

  test('進み具合を割合で出す', async () => {
    const lines: string[] = [];
    await pullModel({
      baseUrl: 'http://x/v1', ref: 'a:1b',
      fetchImpl: fakeOllama(OK).impl, onProgress: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => l.includes('%')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('pulling manifest')), lines.join(' / '));
  });

  test('success が来なければ、成功にしない', async () => {
    // 途中で切れると、最後まで読めても取れていない。
    const cut = [{ status: 'downloading', total: 1000, completed: 300 }];
    await assert.rejects(
      pullModel({ baseUrl: 'http://x/v1', ref: 'a:1b', fetchImpl: fakeOllama(cut).impl }),
      /最後まで終わりませんでした/);
  });

  test('途中で流れてくる失敗を見逃さない', async () => {
    const failing = [
      { status: 'pulling manifest' },
      { error: 'pull model manifest: file does not exist' },
    ];
    await assert.rejects(
      pullModel({ baseUrl: 'http://x/v1', ref: 'nope:1b', fetchImpl: fakeOllama(failing).impl }),
      /Ollama が断りました: pull model manifest/);
  });

  test('知らない名前は、確かめ先まで言う', async () => {
    await assert.rejects(
      pullModel({ baseUrl: 'http://x/v1', ref: 'nope:1b', fetchImpl: fakeOllama([], { status: 404 }).impl }),
      /知りません: nope:1b[\s\S]*ollama\.com/);
  });

  test('繋がらないときは、まず ollama serve を疑わせる', async () => {
    const dead = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(
      pullModel({ baseUrl: 'http://x/v1', ref: 'a:1b', fetchImpl: dead }),
      /繋がりません[\s\S]*ollama serve/);
  });

  test('壊れた行が混ざっても、全体を落とさない', async () => {
    // 1行読めないだけで取得全体を失敗にするのは過剰。
    const impl = (async () => new Response(
      '{"status":"pulling manifest"}\n<html>これはJSONではない\n{"status":"success"}\n',
    )) as unknown as typeof fetch;
    await pullModel({ baseUrl: 'http://x/v1', ref: 'a:1b', fetchImpl: impl });
  });

  test('行が塊の途中で切れても、繋いで読む', async () => {
    // 実際の通信では、1行が複数の塊にまたがる。
    const chunks = ['{"status":"pulling ', 'manifest"}\n{"status":"suc', 'cess"}\n'];
    const impl = (async () => new Response(new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }))) as unknown as typeof fetch;
    await pullModel({ baseUrl: 'http://x/v1', ref: 'a:1b', fetchImpl: impl });
  });
});
