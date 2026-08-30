import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderErrorKind } from '@aas/provider-contract';
import { FallbackPolicy } from './FallbackPolicy.js';

const e = (kind: ProviderErrorKind, retryAfterMs?: number) =>
  new ProviderError({ kind, providerId: 'p', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

describe('FallbackPolicy', () => {
  const p = new FallbackPolicy(500);

  it('§4.2 の表どおりに再試行・フォールバック・冷却を決める', () => {
    const table: [ProviderErrorKind, boolean, boolean, number | null][] = [
      ['rate_limited', true, true, 60_000],
      ['quota_exhausted', false, true, 30 * 60_000],
      ['unavailable', true, true, 5 * 60_000],
      ['timeout', true, true, 5 * 60_000],
      ['context_too_long', true, true, 0],
      ['auth', false, true, null],
      ['invalid_request', false, false, 0],
      ['content_filtered', false, false, 0],
    ];
    for (const [kind, retry, fallback, cooldown] of table) {
      expect([kind, p.shouldRetry(e(kind), 0)]).toEqual([kind, retry]);
      expect([kind, p.shouldFallback(e(kind))]).toEqual([kind, fallback]);
      expect([kind, p.cooldownMsFor(e(kind))]).toEqual([kind, cooldown]);
    }
  });

  it('retryAfter があれば尊重し、無ければ指数バックオフする', () => {
    expect(p.nextDelayMs(0, e('rate_limited', 3000))).toBe(3000);
    expect(p.nextDelayMs(0)).toBe(500);
    expect(p.nextDelayMs(2)).toBe(2000);
  });

  it('unavailable の再試行は2回まで', () => {
    expect(p.shouldRetry(e('unavailable'), 1)).toBe(true);
    expect(p.shouldRetry(e('unavailable'), 2)).toBe(false);
  });
});
