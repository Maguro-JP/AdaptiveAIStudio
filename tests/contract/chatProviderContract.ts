import { describe, expect, it } from 'vitest';
import type { ChatProvider, ProviderChunk, ProviderRequest } from '@aas/provider-contract';
import { isProviderError } from '@aas/provider-contract';

export interface ContractHarness {
  /** 正常応答を返す Provider。 */
  ok(): ChatProvider;
  /** 429 を返す Provider。 */
  rateLimited(): ChatProvider;
  /** context超過を返す Provider。 */
  contextTooLong(): ChatProvider;
  /** usage を返さない Provider。 */
  withoutUsage(): ChatProvider;
  /** 応答が終わらない Provider (中断テスト用)。 */
  hanging(): ChatProvider;
  request(): ProviderRequest;
}

async function collect(p: ChatProvider, req: ProviderRequest, signal: AbortSignal) {
  const chunks: ProviderChunk[] = [];
  for await (const c of p.chat(req, signal)) chunks.push(c);
  return chunks;
}

/**
 * 全 Provider 共通の適合テスト。
 * 新規 Provider はこれをパスすることを追加条件とする (§4.4)。
 */
export function runChatProviderContract(name: string, harness: ContractHarness): void {
  describe(`ChatProvider contract: ${name}`, () => {
    it('ストリームが順序通り届き、最後に必ず done が来る', async () => {
      const chunks = await collect(harness.ok(), harness.request(), new AbortController().signal);
      expect(chunks.at(-1)?.type).toBe('done');
      expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
      const text = chunks.filter((c) => c.type === 'text').map((c) => c.delta).join('');
      expect(text).toBe('こんにちは');
    });

    it('AbortSignal で確実に中断される', async () => {
      const ac = new AbortController();
      const provider = harness.hanging();
      const run = (async () => {
        try {
          await collect(provider, harness.request(), ac.signal);
          return 'completed';
        } catch (e) {
          return isProviderError(e) ? e.kind : 'unknown';
        }
      })();
      queueMicrotask(() => ac.abort());
      expect(await run).toBe('canceled');
    });

    it('429 応答が rate_limited に正規化される', async () => {
      await expect(
        collect(harness.rateLimited(), harness.request(), new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'rate_limited' });
    });

    it('context超過が context_too_long に正規化される', async () => {
      await expect(
        collect(harness.contextTooLong(), harness.request(), new AbortController().signal),
      ).rejects.toMatchObject({ kind: 'context_too_long' });
    });

    it('usage が取得できない場合も推定値で埋まる', async () => {
      const chunks = await collect(
        harness.withoutUsage(),
        harness.request(),
        new AbortController().signal,
      );
      const usage = chunks.find((c) => c.type === 'usage');
      expect(usage).toBeDefined();
      expect(usage?.type === 'usage' && usage.outputTokens).toBeGreaterThan(0);
    });

    it('health() が到達性を返す', async () => {
      expect((await harness.ok().health()).reachable).toBe(true);
    });
  });
}
