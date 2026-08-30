import type { ProviderId } from '@aas/core';

export type ProviderErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unavailable'
  | 'timeout'
  | 'context_too_long'
  | 'auth'
  | 'invalid_request'
  | 'content_filtered'
  | 'canceled';

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  providerId: ProviderId;
  message?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * 各SDK固有の例外は必ずアダプタ内でこの型へ変換する。
 * Application層は HTTP ステータスも SDK 例外も見ない。
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId: ProviderId;
  readonly retryAfterMs?: number;

  constructor(init: ProviderErrorInit) {
    super(init.message ?? `${init.providerId}: ${init.kind}`, 
      init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.providerId = init.providerId;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
