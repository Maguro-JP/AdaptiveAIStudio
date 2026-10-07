/**
 * モデルとの通信と候補の切り替えの不具合（71 回目の調査）。
 *
 * - 空の終わりの合図（`""`）を毎回付けてくる中継で、途中で閉じた流れを「言い終えた」にした
 * - 流れの中の本文が部品の配列だと、本文を全部捨てた
 * - 一度の依頼の中で、冷やした口の次の候補をそのまま叩いた
 * - 並んで走る依頼の成功が、別の依頼が後から付けた冷やしを消した
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function sse(lines: string[]): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const l of lines) res.write(`data: ${l}\n\n`);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function run(baseUrl: string): Promise<{ text: string; error?: ProviderError }> {
  const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl, locality: 'local' });
  const out: { text: string; error?: ProviderError } = { text: '' };
  try {
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'text') out.text += ch.delta;
    }
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    out.error = e;
  }
  return out;
}

describe('流れの読み方', () => {
  test('**空の終わりの合図のまま閉じた流れは、途中で切れたと言う**', async () => {
    const out = await run(await sse([JSON.stringify({ choices: [{ delta: { content: '途中' }, finish_reason: '' }] })]));
    assert.equal(out.error?.kind, 'unavailable', `言い終えたことにした: ${out.text}`);
  });

  test('**本文が部品の配列でも読む（考えの部品は混ぜない）**', async () => {
    const out = await run(await sse([
      JSON.stringify({ choices: [{ delta: { content: [{ type: 'thinking', text: '考え中' }, { type: 'text', text: 'こんにちは' }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    assert.equal(out.text, 'こんにちは');
  });
});

describe('候補の切り替え', () => {
  test('**冷やした口の次の候補は、同じ依頼の中では飛ばす**', async () => {
    let aCalls = 0;
    const fake = (id: string, locality: 'cloud' | 'local', chat: () => AsyncIterable<never>) => ({
      id, locality, health: async () => ({ ok: true }), listModels: async () => [], chat,
    });
    const registry = new ProviderRegistry();
    registry.register(fake('A', 'cloud', async function* () {
      aCalls += 1;
      throw new ProviderError({ kind: 'auth', providerId: 'A', message: '鍵が違います' });
    }) as never);
    registry.register(fake('B', 'cloud', async function* () {
      yield { type: 'text', delta: 'B が答えた' } as never;
      yield { type: 'done', finishReason: 'stop' } as never;
    }) as never);
    const events: ChatEvent[] = [];
    for await (const ev of new ChatOrchestrator(registry).run(
      { candidates: ['A:m1', 'A:m2', 'B:x'], messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal,
    )) events.push(ev);
    assert.equal(aCalls, 1, `冷やした口をもう一度叩いた: ${aCalls} 回`);
    assert.equal(events.find((e) => e.type === 'done')?.modelId, 'B:x');
  });

  test('**成功で解くのは、試しを始める前に付いた冷やしだけ**', () => {
    const registry = new ProviderRegistry();
    let now = 0;
    registry.setClockForTest(() => now);
    now = 10;
    registry.cooldown('A', 60_000, '残高切れ');
    registry.clearCooldown('A', 5);      // 5 に始めた試しの成功
    assert.equal(registry.isAvailable('A'), false, '後から付いた冷やしを消した');
    registry.clearCooldown('A', 20);     // 20 に始めた試しの成功
    assert.equal(registry.isAvailable('A'), true);
  });
});
