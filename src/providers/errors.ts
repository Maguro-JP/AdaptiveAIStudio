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

/**
 * 本文が残高・クォータ切れを言っているか。
 *
 * 先に JSON の `error.code`・`error.type` を見る（`insufficient_quota` は切れ、`rate_limit_exceeded` は一時的な制限）。
 * 語で見るときは URL を除いた文で、切れを言う言い回しに絞る。本文全体の `billing` で見ていたので、一時的な制限の
 * 本文に入った `…/account/billing` の URL に当たり、やり直さずに 30 分冷やしていた。
 */
export function sayQuotaExhausted(body: string): boolean | undefined {
  let code = '';
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    code = `${String(j?.error?.code ?? '')} ${String(j?.error?.type ?? '')}`;
  } catch { /* JSON でない本文は語で見る */ }
  if (/insufficient_quota|billing_hard_limit/i.test(code)) return true;
  if (/rate_limit/i.test(code)) return false;
  const text = body.replace(/https?:\/\/\S+/g, '');
  if (/exceeded your current quota|insufficient[_ ]quota|insufficient (balance|credits?|funds)|credit balance|out of credits/i.test(text)) return true;
  return undefined;
}

/** ツールを渡したが、そのモデルがツールに対応していない（次の候補なら対応しているかもしれない）。 */
function saysNoTools(body: string): boolean {
  return /does not support tools|tools? (is|are) not supported|tool use is not supported/i.test(body);
}

/** HTTPステータスから kind を決める。全アダプタで共有する唯一の変換規則。 */
export function kindFromHttpStatus(status: number, body: string): ProviderErrorKind {
  // 402（Payment Required）は残高切れ（OpenRouter・DeepSeek）。次の候補へ回す。扱っていなかったので
  // 「こちらの誤り」になり、手元の候補が後ろに並んでいても依頼ごと落ちていた
  if (status === 402) return 'quota_exhausted';
  if (status === 429) {
    // 「制限」と「クォータ切れ」はステータスが同じなので本文で見分ける
    return sayQuotaExhausted(body) === true ? 'quota_exhausted' : 'rate_limited';
  }
  if (status === 413) return 'context_too_long';
  if (status === 401 || status === 403) return 'auth';
  // 404 のうち、本文がモデルの話をしているものだけ（Ollama の `model "x" not found`、OpenAI の `The model … does not exist`）。
  // 道の打ち間違い（/v1 の抜け）まで次の候補へ回すと、打ち間違いが隠れるので、それは今までどおり止める
  if (status === 404 && /model/i.test(body)) return 'model_missing';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  if (status === 400 && /context|too long|maximum.*token|token.*limit/i.test(body)) {
    return 'context_too_long';
  }
  // 残高切れを 400 で返す相手がいる（Claude の `credit balance is too low`）
  if (status === 400 && sayQuotaExhausted(body) === true) return 'quota_exhausted';
  // ツールに対応していないモデル（Ollama の `does not support tools`）は、冷やさずに次の候補へ
  if (status === 400 && saysNoTools(body)) return 'model_missing';
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
