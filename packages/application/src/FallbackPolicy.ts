import type { ProviderErrorKind, ProviderError } from '@aas/provider-contract';

export interface KindRule {
  /** 同一Providerに対する再試行回数。 */
  maxRetries: number;
  /** 他モデルへ切り替えてよいか。 */
  canFallback: boolean;
  /** Provider を冷却する時間 (ms)。null は「手動解除まで」、0 は冷却なし。 */
  cooldownMs: number | null;
}

export const FALLBACK_RULES: Readonly<Record<ProviderErrorKind, KindRule>> = {
  rate_limited: { maxRetries: 1, canFallback: true, cooldownMs: 60_000 },
  quota_exhausted: { maxRetries: 0, canFallback: true, cooldownMs: 30 * 60_000 },
  unavailable: { maxRetries: 2, canFallback: true, cooldownMs: 5 * 60_000 },
  timeout: { maxRetries: 2, canFallback: true, cooldownMs: 5 * 60_000 },
  context_too_long: { maxRetries: 1, canFallback: true, cooldownMs: 0 },
  auth: { maxRetries: 0, canFallback: true, cooldownMs: null },
  invalid_request: { maxRetries: 0, canFallback: false, cooldownMs: 0 },
  content_filtered: { maxRetries: 0, canFallback: false, cooldownMs: 0 },
  canceled: { maxRetries: 0, canFallback: false, cooldownMs: 0 },
};

export class FallbackPolicy {
  constructor(private readonly baseDelayMs = 500) {}

  rule(kind: ProviderErrorKind): KindRule {
    return FALLBACK_RULES[kind];
  }

  /** 同一Providerでもう一度試すか。attempt は 0 始まり (0 = 初回失敗直後)。 */
  shouldRetry(e: ProviderError, attempt: number): boolean {
    return attempt < this.rule(e.kind).maxRetries;
  }

  /** 別モデルへ切り替えてよいか。 */
  shouldFallback(e: ProviderError): boolean {
    return this.rule(e.kind).canFallback;
  }

  nextDelayMs(attempt: number, e?: ProviderError): number {
    if (e?.retryAfterMs !== undefined) return e.retryAfterMs;
    return this.baseDelayMs * 2 ** attempt;
  }

  cooldownMsFor(e: ProviderError): number | null {
    return this.rule(e.kind).cooldownMs;
  }
}
