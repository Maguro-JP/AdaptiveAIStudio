/**
 * 監査ログ — 何が起き、ハーネスが何を止めたかを残す。
 *
 * ハーネス自体が誤っていることもある。
 * 記録が無いと「なぜ止まったのか」も「なぜ通ったのか」も追えない。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export class AuditLog {
  readonly #path?: string;
  readonly #entries: AuditEntry[] = [];

  constructor(path?: string) {
    this.#path = path;
  }

  async record(entry: Omit<AuditEntry, 'at'>): Promise<void> {
    const full: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.#entries.push(full);
    if (!this.#path) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, JSON.stringify(full) + '\n', 'utf8');
    } catch {
      // 記録に失敗しても本体は止めない
    }
  }

  entries(): AuditEntry[] {
    return [...this.#entries];
  }

  /** 止めた回数の内訳。規則が効きすぎ/効かなすぎを判断する材料。 */
  summary(): { allowed: number; denied: number; warned: number; violations: number; byRule: Map<string, number> } {
    const byRule = new Map<string, number>();
    let allowed = 0, denied = 0, warned = 0, violations = 0;
    for (const e of this.#entries) {
      if (e.outcome === 'allowed') allowed += 1;
      else if (e.outcome === 'denied') denied += 1;
      else if (e.outcome === 'warned') warned += 1;
      else violations += 1;
      if (e.rule) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
    }
    return { allowed, denied, warned, violations, byRule };
  }
}
