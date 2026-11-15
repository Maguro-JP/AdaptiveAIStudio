/**
 * スマホから使う（docs/PHONE.md）。
 *
 * 既定では閉じている。設定の「スマホから使う」を入れたときだけ、PC の LAN の住所（家や会社の中だけで通じる住所）にも
 * 口を開ける。LAN の口から来た要求は、パスフレーズで受け取ったトークン（token）が無ければ、画面の頁より先へは通さない。
 *
 * - 開ける住所は、私用の範囲（10/8・172.16/12・192.168/16・169.254/16・fc00::/7・fe80::/10）だけ。
 *   公の住所の機械には開けず、私用の範囲の外から来た繋ぎも断る
 * - パスフレーズは 16 字（読み違えやすい字を抜いた 32 種の字。80 ビット）。作り直すと、渡したトークンは全部効かなくなる
 * - トークンは Cookie（HttpOnly・SameSite=Strict）で渡す。本体にはトークンの SHA-256 だけを置く
 * - パスフレーズを間違えた回数を、繋いできた住所ごとと全体とで数え、多ければしばらく断る
 * - 127.0.0.1 の口（PC の画面）は今までと同じ。トークンは要らない
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeWhole } from '../core/journal-file.ts';

/** パスフレーズに使う字。0/O・1/l/I・u/v のような見分けにくい字を抜いた 32 種。 */
const ALPHABET = '23456789abcdefghjkmnpqrstwxyzACD';

export const COOKIE = 'aas_phone';
/** トークンが効く長さ（30 日）。ホーム画面に置いて使い続けるので短くしない。パスフレーズを作り直せば即座に効かなくなる。 */
export const TOKEN_DAYS = 30;
/** 住所ごとに、この時間の中で、この回数を超えて間違えたら断る。 */
export const FAIL_WINDOW_MS = 10 * 60 * 1000;
export const FAILS_PER_ADDRESS = 5;
export const FAILS_TOTAL = 20;

function v4(addr: string): number[] | undefined {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(addr);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

/** 自分の機械の中（127/8・::1）。 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const p = v4(addr);
  if (p) return p[0] === 127;
  return addr === '::1';
}

/** 私用の範囲（家や会社の中だけで通じる住所）。公の住所と、読めない形は false。 */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const p = v4(addr);
  if (p) {
    const [a, b] = p as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const s = addr.toLowerCase().split('%')[0]!;
  if (!s.includes(':')) return false;
  const head = parseInt(s.split(':')[0] || '0', 16);
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80;
}

/** LAN の口として開けてよい住所か（私用の範囲か、試験のための自分の機械の中）。 */
export function canListenOn(addr: string): boolean {
  return isPrivateAddress(addr) || isLoopback(addr);
}

/** この PC の LAN の住所（IPv4 の私用の範囲だけ）。スマホに見せるのは先頭。 */
export function lanAddresses(nets: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && isPrivateAddress(n.address) && !n.address.startsWith('169.254.')) out.push(n.address);
    }
  }
  // 169.254 は相手の居ない線で付く住所。あれば最後に回す（見せる先頭にしない）
  for (const list of Object.values(nets)) for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal && n.address.startsWith('169.254.')) out.push(n.address);
  return out;
}

export function newPassphrase(): string {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i]! & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}

/** 打ったパスフレーズを比べられる形にする（区切りと空白を外す。字の大小は区別する）。 */
function plain(p: string): string {
  return p.normalize('NFKC').replace(/[\s\-‐－ー]/g, '');
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface PhoneSaved {
  enabled: boolean;
  passphrase: string;
  /** 渡したトークンの SHA-256 と、効く期限（ミリ秒）。 */
  tokens: Array<{ hash: string; until: number }>;
}

export type PairResult =
  | { ok: true; token: string }
  | { ok: false; status: 401 | 429; error: string; retryAfterSec?: number };

/** パスフレーズとトークンを持つ係。時刻は渡せる（試験で決まった値にするため）。 */
export class PhoneAccess {
  #saved: PhoneSaved;
  readonly #file: string | undefined;
  readonly #now: () => number;
  readonly #fails = new Map<string, number[]>();
  #allFails: number[] = [];

  constructor(opts: { file?: string; now?: () => number; saved?: PhoneSaved } = {}) {
    this.#file = opts.file;
    this.#now = opts.now ?? Date.now;
    this.#saved = opts.saved ?? { enabled: false, passphrase: newPassphrase(), tokens: [] };
  }

  /** 置いた設定を読む。無い・壊れているときは、閉じた状態から始める（開いたままにはしない）。 */
  static async load(file: string, now?: () => number): Promise<PhoneAccess> {
    let saved: PhoneSaved | undefined;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<PhoneSaved>;
      if (typeof raw.passphrase === 'string' && plain(raw.passphrase).length >= 12) {
        saved = {
          enabled: raw.enabled === true,
          passphrase: raw.passphrase,
          tokens: Array.isArray(raw.tokens) ? raw.tokens.filter((t) => typeof t?.hash === 'string' && typeof t?.until === 'number') : [],
        };
      }
    } catch { /* 無い・壊れている */ }
    return new PhoneAccess({ file, ...(now ? { now } : {}), ...(saved ? { saved } : {}) });
  }

  get enabled(): boolean { return this.#saved.enabled; }
  get passphrase(): string { return this.#saved.passphrase; }

  async setEnabled(on: boolean): Promise<void> {
    this.#saved.enabled = on;
    await this.#save();
  }

  /** パスフレーズを作り直す。渡したトークンは全部効かなくなる。 */
  async regenerate(): Promise<string> {
    this.#saved.passphrase = newPassphrase();
    this.#saved.tokens = [];
    this.#fails.clear();
    this.#allFails = [];
    await this.#save();
    return this.#saved.passphrase;
  }

  /** パスフレーズを受けて、トークンを渡す。間違いが多いと、正しくてもしばらく断る（当て続けさせない）。 */
  async pair(from: string, typed: unknown): Promise<PairResult> {
    const now = this.#now();
    const recent = (this.#fails.get(from) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.#allFails = this.#allFails.filter((t) => now - t < FAIL_WINDOW_MS);
    const blocked = recent.length >= FAILS_PER_ADDRESS ? recent : this.#allFails.length >= FAILS_TOTAL ? this.#allFails : undefined;
    if (blocked) {
      const retryAfterSec = Math.max(1, Math.ceil((blocked[0]! + FAIL_WINDOW_MS - now) / 1000));
      return { ok: false, status: 429, error: `パスフレーズの間違いが続いたので、しばらく受け付けません（あと ${Math.ceil(retryAfterSec / 60)} 分）`, retryAfterSec };
    }
    const a = Buffer.from(sha(plain(typeof typed === 'string' ? typed : '')));
    const b = Buffer.from(sha(plain(this.#saved.passphrase)));
    if (!timingSafeEqual(a, b)) {
      recent.push(now);
      this.#fails.set(from, recent);
      this.#allFails.push(now);
      const left = FAILS_PER_ADDRESS - recent.length;
      return { ok: false, status: 401, error: left > 0 ? `パスフレーズが違います（あと ${left} 回まで）` : 'パスフレーズが違います。しばらく受け付けません' };
    }
    this.#fails.delete(from);
    const token = randomBytes(32).toString('base64url');
    this.#saved.tokens = this.#saved.tokens.filter((t) => t.until > now);
    this.#saved.tokens.push({ hash: sha(token), until: now + TOKEN_DAYS * 86_400_000 });
    await this.#save();
    return { ok: true, token };
  }

  /** Cookie の見出しからトークンを取り出して、効くかを見る。 */
  allows(cookieHeader: string | undefined): boolean {
    const token = readCookie(cookieHeader, COOKIE);
    if (!token) return false;
    const h = sha(token);
    const now = this.#now();
    return this.#saved.tokens.some((t) => t.until > now && t.hash === h);
  }

  async #save(): Promise<void> {
    if (!this.#file) return;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeWhole(this.#file, JSON.stringify(this.#saved, null, 2));
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function cookieFor(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_DAYS * 86_400}`;
}

/** LAN の口から、トークンなしで読ませてよい所（画面の頁そのもの。中身を持たない）。 */
export function openWithoutToken(path: string, method: string): boolean {
  if (path === '/api/phone/pair') return method === 'POST';
  return !path.startsWith('/api/');
}
