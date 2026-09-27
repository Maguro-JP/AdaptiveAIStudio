/**
 * 名簿の変更記録 — 誰が入り、誰の仕事が変わったか。
 *
 * 方針:
 *   1. 役職は消さない。仕事を細分化するか、より合う仕事を渡す
 *   2. 名前と機能は基本的に変えない。混乱するため
 *   3. 違和感が出たら変える
 *   4. 変えたら必ず周知する
 *
 * 4つ目が仕組みとして要る。
 * 黙って変えると、利用者は「前と違う」ことに気づけない。
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Role } from './role.ts';
import { loadJournal, saveJournal } from '../core/journal-file.ts';

export type ChangeKind =
  | 'joined'      // 新しく配属された
  | 'renamed'     // 呼び名が変わった
  | 'reassigned'  // 責務が変わった
  | 'retuned'     // 気質が変わった
  | 'authorized'  // 権限が変わった
  | 'succeeded';  // 仕事を引き継いだ / 引き継がれた

export interface RoleChange {
  at: string;
  kind: ChangeKind;
  roleId: string;
  codename: string;
  detail: string;
}

interface Snapshot {
  id: string;
  codename: string;
  name: string;
  responsibility: string;
  disposition: string;
  access: string[];
  succeededBy?: string[];
  signature: string;
}

export class RoleLedger {
  readonly #path?: string;
  #known = new Map<string, Snapshot>();
  #unannounced: RoleChange[] = [];
  /**
   * 記録が在るのに読めなかった。前の名簿が分からないので、照合しても「変わった」とは言わない（全員を「配属されました」と
   * 知らせ直していた）。保存の前に読み直し、読めたら前の名簿を取り込む（`src/core/journal-file.ts`）。
   */
  #blind = false;

  constructor(path?: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    this.#known = new Map();
    this.#unannounced = [];
    // 形の違う一件（`null`・権限が配列でない等）は、その一件だけ除く。そのまま入れると、照合の途中で投げていた。
    const got = await loadJournal(this, this.#path, (v) => {
      const raw = readLedger(v);
      this.#known = new Map(raw.known.map((s) => [s.id, s]));
      this.#unannounced = raw.unannounced;
    });
    this.#blind = got === 'unreadable';
  }

  /**
   * 現在の名簿と照合し、変わったところを記録する。
   * 消えた役職があれば、それも見逃さない（方針違反として残す）。
   */
  sync(roles: Role[]): RoleChange[] {
    const now = new Date().toISOString();
    const changes: RoleChange[] = [];
    const current = new Map(roles.map((r) => [r.id, r]));

    for (const role of roles) {
      const snap = snapshotOf(role);
      const before = this.#known.get(role.id);

      if (!before) {
        // 改名なら、前の名前の記録を引き継ぐ
        const previous = (role.formerly ?? [])
          .map((id) => this.#known.get(id))
          .find((s) => s !== undefined);
        if (previous) {
          changes.push({
            at: now, kind: 'renamed', roleId: role.id, codename: role.codename,
            detail: `${previous.codename} から ${role.codename} に改名しました。古い名前でも呼べます。`,
          });
        } else {
          changes.push({
            at: now, kind: 'joined', roleId: role.id, codename: role.codename,
            detail: `${role.codename}（${role.name}）が配属されました。${role.responsibility}`,
          });
        }
        this.#known.set(role.id, snap);
        continue;
      }

      if (before.signature === snap.signature) continue;

      if (before.codename !== snap.codename) {
        changes.push({
          at: now, kind: 'renamed', roleId: role.id, codename: role.codename,
          detail: `${before.codename} から ${role.codename} に改名しました。`,
        });
      }
      if (before.responsibility !== snap.responsibility) {
        changes.push({
          at: now, kind: 'reassigned', roleId: role.id, codename: role.codename,
          detail: `${role.codename} の担当が変わりました: ${snap.responsibility}`,
        });
      }
      if (before.disposition !== snap.disposition) {
        changes.push({
          at: now, kind: 'retuned', roleId: role.id, codename: role.codename,
          detail: `${role.codename} の姿勢を調整しました。`,
        });
      }
      if (before.access.join(',') !== snap.access.join(',')) {
        changes.push({
          at: now, kind: 'authorized', roleId: role.id, codename: role.codename,
          detail: `${role.codename} の権限が ${before.access.join('/')} から ${snap.access.join('/')} に変わりました。`,
        });
      }
      const newSuccessors = (snap.succeededBy ?? [])
        .filter((id) => !(before.succeededBy ?? []).includes(id));
      if (newSuccessors.length > 0) {
        const names = newSuccessors.map((id) => current.get(id)?.codename ?? id);
        changes.push({
          at: now, kind: 'succeeded', roleId: role.id, codename: role.codename,
          detail: `${role.codename} の仕事は ${names.join(' と ')} が引き継ぎました。名簿には残ります。`,
        });
      }

      this.#known.set(role.id, snap);
    }

    // 名簿から消えた役職。方針では消さないので、記録に残して気づけるようにする。
    for (const [id, snap] of this.#known) {
      if (current.has(id)) continue;
      changes.push({
        at: now, kind: 'succeeded', roleId: id, codename: snap.codename,
        detail: `${snap.codename} が名簿から消えています。役職は消さず、` +
          '仕事の引き継ぎ先を succeededBy で示してください。',
      });
    }

    if (this.#blind) return []; // 前が分からない。今の名簿だけ覚え、知らせない
    this.#unannounced.push(...changes);
    return changes;
  }

  /** まだ伝えていない変更。 */
  pending(): RoleChange[] {
    return [...this.#unannounced];
  }

  /** 伝えたので消す。 */
  markAnnounced(): void {
    this.#unannounced = [];
  }

  /** 書く。一時ファイルから付け替える。起動のときに読めなかったなら、読めるまで書かない。記録に失敗しても本体は止めない。 */
  async save(): Promise<void> {
    if (!this.#path) return;
    await mkdir(dirname(this.#path), { recursive: true }).catch(() => undefined);
    await saveJournal(this, this.#path, () => JSON.stringify({
      known: [...this.#known.values()],
      unannounced: this.#unannounced,
    }, null, 2), (v) => {
      // 読めなかった間に覚えた名簿の方が新しい。覚えていない役職と、まだ伝えていない変更だけ取り込む
      const raw = readLedger(v);
      for (const s of raw.known) if (!this.#known.has(s.id)) this.#known.set(s.id, s);
      this.#unannounced = [...raw.unannounced, ...this.#unannounced];
    }).catch(() => false);
  }
}

const CHANGE_KINDS = new Set<string>(['joined', 'renamed', 'reassigned', 'retuned', 'authorized', 'succeeded']);
const isText = (x: unknown): x is string => typeof x === 'string';
const isTexts = (x: unknown): x is string[] => Array.isArray(x) && x.every(isText);

function isSnapshot(v: unknown): v is Snapshot {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isText(r.id) && isText(r.codename) && isText(r.name) && isText(r.responsibility)
    && isText(r.disposition) && isTexts(r.access) && isText(r.signature)
    && (r.succeededBy === undefined || isTexts(r.succeededBy));
}

function isChange(v: unknown): v is RoleChange {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isText(r.at) && isText(r.kind) && CHANGE_KINDS.has(r.kind) && isText(r.roleId)
    && isText(r.codename) && isText(r.detail);
}

/** 記録のうち、形の合う分だけ。入れ物でなければ空。 */
function readLedger(v: unknown): { known: Snapshot[]; unannounced: RoleChange[] } {
  const r = (v ?? {}) as Record<string, unknown>;
  return {
    known: Array.isArray(r.known) ? r.known.filter(isSnapshot) : [],
    unannounced: Array.isArray(r.unannounced) ? r.unannounced.filter(isChange) : [],
  };
}

function snapshotOf(role: Role): Snapshot {
  const base = {
    id: role.id,
    codename: role.codename,
    name: role.name,
    responsibility: role.responsibility,
    disposition: role.disposition,
    access: [...role.access],
    succeededBy: role.succeededBy,
  };
  return {
    ...base,
    signature: createHash('sha1')
      .update(JSON.stringify([
        base.codename, base.name, base.responsibility,
        base.disposition, base.access, role.instructions, base.succeededBy,
      ]))
      .digest('hex')
      .slice(0, 12),
  };
}

/** 周知の文面。 */
export function formatChanges(changes: RoleChange[]): string {
  if (changes.length === 0) return '';
  const label: Record<ChangeKind, string> = {
    joined: '配属', renamed: '改名', reassigned: '担当変更',
    retuned: '姿勢の調整', authorized: '権限変更', succeeded: '引き継ぎ',
  };
  const lines = ['名簿の変更'];
  for (const c of changes) lines.push(`  [${label[c.kind]}] ${c.detail}`);
  return lines.join('\n');
}
