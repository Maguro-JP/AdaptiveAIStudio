/**
 * 画面の口を、よその頁から叩かせない。
 *
 * この口は 127.0.0.1 にしか開いていないが、**ブラウザは何処の頁からでも
 * 127.0.0.1 へ届く。**よそのサイトを開いているあいだに、その頁の中の
 * script が `POST /api/send` を投げれば、この場所は依頼として受け取り、
 * shell まで動かす。中身の読み取りは同一生成元の決まりで防がれるが、
 * **投げること自体は防がれない**（text/plain の POST は事前確認なしに届く）。
 *
 * ブラウザは、よそから来た要求に `Sec-Fetch-Site` と `Origin` を必ず付ける。
 * 付いていて、こちらでなければ断る。付いていない（curl や検査）は通す。
 * `Host` は DNS の付け替え（rebinding）よけ。名前が 127.0.0.1 を指すよう
 * 仕向けられても、Host にはその名前が入る。
 */
export interface OriginRule {
  /** 自分の場所として認める host（port は見ない）。既定で localhost 系は入る。 */
  ownHosts?: string[];
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    // Origin は URL、Host は host[:port]。どちらも URL として読める形にする。
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 断る理由。通してよければ undefined。 */
export function crossSiteReason(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  rule: OriginRule = {},
): string | undefined {
  const own = new Set([...LOCAL, ...(rule.ownHosts ?? []).map((h) => h.toLowerCase())]);
  const one = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };

  // DNS の付け替えよけ。どの方法でも見る。
  const host = hostOf(one('host'));
  if (host !== undefined && !own.has(host) && !own.has(`[${host}]`)) {
    return `Host が自分ではありません: ${host}`;
  }

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined;

  const site = one('sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site' || site === 'same-site') {
    return `よその頁からの要求です（Sec-Fetch-Site: ${site}）`;
  }
  const origin = one('origin');
  if (origin !== undefined && origin !== 'null') {
    const oh = hostOf(origin);
    if (oh === undefined || !own.has(oh)) return `よその頁からの要求です（Origin: ${origin}）`;
  } else if (origin === 'null') {
    return 'よその頁からの要求です（Origin: null）';
  }
  return undefined;
}
