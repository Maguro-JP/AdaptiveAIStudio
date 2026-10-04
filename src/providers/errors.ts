/**
 * 正規化エラー — フォールバック判断の唯一の根拠。
 * 各アダプタは自分の例外を必ずこの型へ変換してから投げる。
 */

export type ProviderErrorKind =
  /** 利用制限。本プロジェクトの主目的。即フォールバック。 */
  | 'rate_limited'
  /** クォータ切れ。当該Providerを長めに冷却。 */
  | 'quota_exhausted'
  /** 5xx・ネットワーク断。リトライ後フォールバック。 */
  | 'unavailable'
  | 'timeout'
  /** context超過。圧縮して再試行。 */
  | 'context_too_long'
  /** 認証不備。自動復旧しないのでフォールバックする。 */
  | 'auth'
  /**
   * そのモデルが相手に無い（404）。設定に書いてあるだけの名前・消されたモデル。相手ごと冷やさず、次の候補へ回す
   * （こちらのバグとして止めていたので、候補に次のモデルが在っても使わずに落ちていた）。
   */
  | 'model_missing'
  /** こちらのバグ。フォールバックしても直らない。 */
  | 'invalid_request'
  | 'canceled';

export interface FallbackRule {
  /** 同一Providerへのリトライ回数 */
  retries: number;
  /** 別Providerへ切り替えるか */
  fallback: boolean;
  /** 当該Providerを候補から外す時間(ms)。0なら冷却しない */
  cooldownMs: number;
}

const MINUTE = 60_000;

export const FALLBACK_RULES: Record<ProviderErrorKind, FallbackRule> = {
  rate_limited:     { retries: 1, fallback: true,  cooldownMs: MINUTE },
  quota_exhausted:  { retries: 0, fallback: true,  cooldownMs: 30 * MINUTE },
  unavailable:      { retries: 2, fallback: true,  cooldownMs: 5 * MINUTE },
  timeout:          { retries: 2, fallback: true,  cooldownMs: 5 * MINUTE },
  context_too_long: { retries: 0, fallback: true,  cooldownMs: 0 },
  // 鍵の誤りでも、いつかは試し直す。無期限にしていたので、プロキシが一度だけ返した 403 で、作り直すまで候補から外れたままだった
  auth:             { retries: 0, fallback: true,  cooldownMs: 10 * MINUTE },
  model_missing:    { retries: 0, fallback: true,  cooldownMs: 0 },
  invalid_request:  { retries: 0, fallback: false, cooldownMs: 0 },
  canceled:         { retries: 0, fallback: false, cooldownMs: 0 },
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId: string;
  readonly retryAfterMs?: number;

  constructor(opts: {
    kind: ProviderErrorKind;
    providerId: string;
    message: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.providerId = opts.providerId;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get rule(): FallbackRule {
    return FALLBACK_RULES[this.kind];
  }
}

/** HTTPステータスから kind を決める。全アダプタで共有する唯一の変換規則。 */
export function kindFromHttpStatus(status: number, body: string): ProviderErrorKind {
  if (status === 429) {
    // 「制限」と「クォータ切れ」はステータスが同じなので本文で見分ける
    return /quota|credit|billing|insufficient/i.test(body)
      ? 'quota_exhausted'
      : 'rate_limited';
  }
  if (status === 401 || status === 403) return 'auth';
  // 404 のうち、本文がモデルの話をしているものだけ（Ollama の `model "x" not found`、OpenAI の `The model … does not exist`）。
  // 道の打ち間違い（/v1 の抜け）まで次の候補へ回すと、打ち間違いが隠れるので、それは今までどおり止める
  if (status === 404 && /model/i.test(body)) return 'model_missing';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  if (status === 400 && /context|too long|maximum.*token|token.*limit/i.test(body)) {
    return 'context_too_long';
  }
  return 'invalid_request';
}

/** fetch/中断の例外を正規化する。 */
export function kindFromThrown(e: unknown): ProviderErrorKind {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return 'canceled';
    if (e.name === 'TimeoutError') return 'timeout';
  }
  return 'unavailable';
}

/** Retry-After ヘッダ(秒 または HTTP-date)を ms に。 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
