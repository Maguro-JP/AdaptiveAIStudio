/**
 * 優先度が、送る側から inproc の入口まで届くこと（配線）。
 *
 * 受ける側（LanePool・入口）は inproc-priority.test.ts で見る。ここは送る側:
 * - provider は priority があるときだけ `x-aas-priority` を付ける（数で）
 * - orchestrator は ChatInput の priority を provider へそのまま渡す（無ければ渡さない）
 * - Agent の option の priority が、その依頼のヘッダになる
 * - **並んでいる間は停滞ではない**: 最初のトークン前に届いたバイト（`: queued`）で
 *   first-token の待ちが延びる。届かなければ、これまでどおり落ちる（対）
 *
 * 敵対レビューで、送る側がどこにも試験されていないことが見つかった
 * （orchestrator の受け渡しと provider のヘッダ付与を両方消しても、全部通っていた）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent } from '../src/agent/loop.ts';
import {
  Priority, PRIORITY_HEADER, type ChatProvider, type ProviderRequest, type ProviderChunk,
} from '../src/providers/contract.ts';
import { tempDir } from './tmp.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 受けたヘッダを控えて、決まった答えを流す偽の口。
 * `beats` 回 `: queued` を打ってから答える。`silentMs` の間は何も流さない。
 */
async function inlet(opts: { beats?: number; beatMs?: number; silentMs?: number } = {}) {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"m"}]}');
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      void (async () => {
        const h = req.headers[PRIORITY_HEADER];
        seen.push(Array.isArray(h) ? h[0] : h);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // ヘッダは先に送る。送らないと、最初の write まで相手は「繋がっていない」扱いのまま。
        res.flushHeaders();
        for (let i = 0; i < (opts.beats ?? 0); i += 1) {
          await sleep(opts.beatMs ?? 10);
          if (res.destroyed) return;
          res.write(': queued\n\n');
        }
        if (opts.silentMs) await sleep(opts.silentMs);
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok\nTASK_DONE\n' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const REQ: ProviderRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('優先度の配線: 送る側', () => {
  test('provider は priority があるときだけヘッダを付ける（数で）', async () => {
    const s = await inlet();
    try {
      const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: s.baseUrl, locality: 'local' });
      await drain(provider.chat({ ...REQ, priority: Priority.top }, new AbortController().signal));
      await drain(provider.chat({ ...REQ, priority: Priority.low }, new AbortController().signal));
      await drain(provider.chat(REQ, new AbortController().signal));
      assert.deepEqual(s.seen, ['0', '4', undefined]);
    } finally { await s.close(); }
  });

  test('orchestrator は priority をそのまま渡す。無ければ渡さない（対）', async () => {
    const got: Array<Priority | undefined | 'absent'> = [];
    const fake: ChatProvider = {
      id: 'fake', locality: 'local',
      health: async () => ({ ok: true }),
      listModels: async () => [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }],
      async *chat(req: ProviderRequest): AsyncIterable<ProviderChunk> {
        got.push('priority' in req ? req.priority : 'absent');
        yield { type: 'text', delta: 'x' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(fake);
    const orch = new ChatOrchestrator(registry);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    await drain(orch.run({ candidates: ['fake:m'], messages, priority: Priority.preferred }, new AbortController().signal));
    await drain(orch.run({ candidates: ['fake:m'], messages }, new AbortController().signal));
    assert.deepEqual(got, [Priority.preferred, 'absent']);
  });

  test('Agent の option の priority が、その依頼のヘッダになる', async () => {
    const s = await inlet();
    const root = await tempDir('aas-wire-');
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'p', baseUrl: s.baseUrl, locality: 'local' }));
      const orch = new ChatOrchestrator(registry);
      const run = async (priority?: Priority) => {
        const agent = new Agent(orch, {
          candidates: ['p:m'], system: 'x', tools: [], root, maxTurns: 2,
          approve: async () => true,
          ...(priority !== undefined ? { priority } : {}),
        });
        await drain(agent.run([{ role: 'user', content: 'hi' }], new AbortController().signal));
      };
      await run(Priority.top);
      const withTop = s.seen.splice(0);
      await run();
      const without = s.seen.splice(0);
      assert.ok(withTop.length > 0 && withTop.every((h) => h === '0'), `最優先のはずが: ${withTop.join(',')}`);
      assert.ok(without.length > 0 && without.every((h) => h === undefined), `無いはずが: ${without.join(',')}`);
    } finally { await s.close(); }
  });
});

describe('優先度の配線: 並んでいる間は停滞ではない', () => {
  // 時間そのものを閾値にしないため、鼓動の間隔（25ms）と上限（1.5 秒）を大きく離す。
  // 混んだ機械で鼓動が 1.5 秒以上遅れることは考えにくい。

  test('**最初のトークン前に届いたバイトで、first-token の待ちが延びる**', async () => {
    const s = await inlet({ beats: 100, beatMs: 25 }); // 2.5 秒ぶん鼓動を打ってから答える
    try {
      const provider = new OpenAiCompatibleProvider({
        id: 'p', baseUrl: s.baseUrl, locality: 'local', firstTokenTimeoutMs: 1_500, stallTimeoutMs: 5_000,
      });
      const chunks = await drain(provider.chat(REQ, new AbortController().signal));
      const text = chunks.filter((c) => c.type === 'text').map((c) => c.delta).join('');
      assert.match(text, /ok/);
    } finally { await s.close(); }
  });

  test('何も届かなければ、これまでどおり落ちる（対）', async () => {
    const s = await inlet({ silentMs: 2_500 });
    try {
      const provider = new OpenAiCompatibleProvider({
        id: 'p', baseUrl: s.baseUrl, locality: 'local', firstTokenTimeoutMs: 1_500, stallTimeoutMs: 5_000,
      });
      const err = await drain(provider.chat(REQ, new AbortController().signal)).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof ProviderError, '落ちていない');
      assert.equal(err.kind, 'timeout');
    } finally { await s.close(); }
  });
});
