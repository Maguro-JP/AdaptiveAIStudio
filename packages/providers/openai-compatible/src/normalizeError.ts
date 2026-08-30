import type { ProviderId } from '@aas/core';
import { ProviderError, type ProviderErrorKind } from '@aas/provider-contract';

const CONTEXT_HINTS = ['context length', 'context_length', 'too many tokens', 'maximum context'];

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** HTTP応答を正規化エラーへ変換する。Application層へ生のステータスを漏らさない。 */
export function fromResponse(providerId: ProviderId, res: Response, body: string): ProviderError {
  const lower = body.toLowerCase();
  let kind: ProviderErrorKind;

  if (res.status === 429) {
    kind = /quota|insufficient|credit|billing/.test(lower) ? 'quota_exhausted' : 'rate_limited';
  } else if (res.status === 401 || res.status === 403) {
    kind = 'auth';
  } else if (res.status === 400 && CONTEXT_HINTS.some((h) => lower.includes(h))) {
    kind = 'context_too_long';
  } else if (res.status === 400 || res.status === 404 || res.status === 422) {
    kind = 'invalid_request';
  } else if (res.status >= 500) {
    kind = 'unavailable';
  } else {
    kind = 'unavailable';
  }

  const retryAfterMs = parseRetryAfter(res.headers);
  return new ProviderError({
    kind,
    providerId,
    message: `${providerId} HTTP ${res.status}: ${body.slice(0, 500)}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function fromThrown(providerId: ProviderId, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new ProviderError({ kind: 'canceled', providerId, cause: e });
  }
  if (e instanceof Error && e.name === 'TimeoutError') {
    return new ProviderError({ kind: 'timeout', providerId, cause: e });
  }
  return new ProviderError({
    kind: 'unavailable',
    providerId,
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}
