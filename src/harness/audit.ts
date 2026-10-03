/**
 * 監査ログ — 何が起き、ハーネスが何を止めたかを残す。
 *
 * ハーネス自体が誤っていることもある。
 * 記録が無いと「なぜ止まったのか」も「なぜ通ったのか」も追えない。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WarnOnce, failCode } from '../core/warn-once.ts';
import { isAbsent } from './put-back.ts';

export interface AuditEntry {
  at: string;
  tool: string;
  /** 判定 */
  outcome: 'allowed' | 'denied' | 'warned' | 'violation';
  rule?: string;
  reason?: string;
  /** 引数の要約（全文は残さない） */
  summary?: string;
}

/**
 * 手元に持つ記録の数と、ファイルの大きさの上限。
 *
 * 通った呼び出しも毎回記録するので、画面を開いたままにすると、手元の記録は増え続け、ファイルも片づけ（`npm run clean`）の外で
 * 増え続けていた。手元は新しい分だけを持ち（数え上げは別に数える）、ファイルは上限を超えたら一つ前（`.1`）へ回す。
 */
export const AUDIT_KEEP = 2000;
export const AUDIT_MAX_BYTES = 8 * 1024 * 1024;
/** ファイルの大きさを見る間隔（書くたびには見ない） */
const SIZE_CHECK_EVERY = 100;

export class AuditLog {
  readonly #path?: string;
  readonly #entries: AuditEntry[] = [];
  readonly #warn = new WarnOnce();
  readonly #keep: number;
  readonly #maxBytes: number;
  #since = 0;
  readonly #counts = { allowed: 0, denied: 0, warned: 0, violations: 0 };
  readonly #byRule = new Map<string, number>();

  constructor(path?: string, opts: { keep?: number; maxBytes?: number } = {}) {
    this.#path = path;
    this.#keep = opts.keep ?? AUDIT_KEEP;
    this.#maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
  }

  async record(entry: Omit<AuditEntry, 'at'>): Promise<void> {
    const full: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.#entries.push(full);
    if (this.#entries.length > this.#keep) this.#entries.splice(0, this.#entries.length - this.#keep);
    if (full.outcome === 'allowed') this.#counts.allowed += 1;
    else if (full.outcome === 'denied') this.#counts.denied += 1;
    else if (full.outcome === 'warned') this.#counts.warned += 1;
    else this.#counts.violations += 1;
    if (full.rule) this.#byRule.set(full.rule, (this.#byRule.get(full.rule) ?? 0) + 1);
    if (!this.#path) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      // 上限を超えていたら一つ前へ回す（前の `.1` は捨てる）。回せなくても書き足しは続ける
      if (this.#since++ % SIZE_CHECK_EVERY === 0) await this.#rotate(this.#path);
      await appendFile(this.#path, JSON.stringify(full) + '\n', 'utf8');
      this.#warn.ok();
    } catch (e) {
      // 記録に失敗しても本体は止めない。ただし黙らない（続けて失敗している間は一度だけ言う）
      this.#warn.fail(`監査の記録を残せませんでした（${failCode(e)}）。ハーネスが止めた・通した理由が、このあと ${this.#path} に残りません`);
    }
  }

  /**
   * 上限を超えていたら一つ前（`.1`）へ回す。**回せなくても、大きさを見られなくても、書き足しは続ける**（記録を失うより、大きくなる方がまし）。
   *
   * 画面と端末の二つが同じファイルに書くと、両方が超えたのを見て続けて回し、後の方が前の方の作ったばかりの小さなファイルで `.1` を上書きして、
   * 回した 8MB 分を失う。回す直前にもう一度見て、最初に見たものと同じファイル（ino と大きさ）のときだけ回す。
   */
  async #rotate(path: string): Promise<void> {
    let first: import('node:fs').Stats;
    try { first = await stat(path); } catch (e) {
      // まだ無いのは普通。ほかの読めなさ（掴まれている）は、この回は見送るだけで、書き足しは止めない。ただし黙らない
      if (!isAbsent(e)) this.#warn.fail(`監査の記録の大きさを見られませんでした（${failCode(e)}）。一つ前へ回すのを見送ります`);
      return;
    }
    if (first.size <= this.#maxBytes) return;
    try {
      const again = await stat(path);
      if (again.ino !== first.ino || again.size < first.size) return; // 別の本体がもう回した
      await rename(path, `${path}.1`);
    } catch (e) {
      if (isAbsent(e)) return; // 別の本体が回した直後
      this.#warn.fail(`監査の記録を一つ前へ回せませんでした（${failCode(e)}）。${path} が ${Math.round(first.size / 1024 / 1024)}MB を超えて増えています`);
    }
  }

  /** 残せなかったことを言う先。 */
  warnTo(say: (text: string) => void): void {
    this.#warn.to(say);
  }

  /** 手元に持っている新しい分（`AUDIT_KEEP` 件まで）。 */
  entries(): AuditEntry[] {
    return [...this.#entries];
  }

  /** 止めた回数の内訳。規則が効きすぎ/効かなすぎを判断する材料。手元から落とした分も数える。 */
  summary(): { allowed: number; denied: number; warned: number; violations: number; byRule: Map<string, number> } {
    return { ...this.#counts, byRule: new Map(this.#byRule) };
  }
}
