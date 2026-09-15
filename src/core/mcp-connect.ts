/**
 * 見本帳から一つ繋ぐ、という一つの手続き。
 *
 * 画面からも、会話からも、同じものを使う。**二重に書かない。**
 * 二つに書くと、片方だけ直したときに「画面からは繋がるが、
 * 言っても繋がらない」になる。
 */
import { join } from 'node:path';
import { aasHome } from './home.ts';
import { writeEnvValue } from './env.ts';
import { saveMcpServer, removeMcpServer } from '../ui/settings.ts';
import { findEntry, specFrom, missingSecrets, needsNpx, CATALOG, type CatalogEntry } from '../mcp/catalog.ts';
import { githubLaunch } from './github-mcp.ts';
import { canRun } from './which.ts';
import type { McpServerSpec } from '../mcp/client.ts';

export interface ConnectResult {
  ok: boolean;
  id?: string;
  /** 設定を書いた場所。 */
  path?: string;
  /** まだ足りていない合言葉。**足りないものは、足りないと言う。** */
  missing: { env: string; about: string; where?: string }[];
  /** 言っておくこと（廃止、npm が要る、など）。 */
  notes: string[];
  error?: string;
  /**
   * 設定へ書いた、立ち上げ方そのもの。
   *
   * **いま動いているセッションへ足すために返す。**ここまでは設定を書くだけで、
   * 動いている側は次に立ち上げ直すまで何も変わらなかった。
   * 「次の依頼から使えます」と言いながら、その依頼では使えない。
   */
  spec?: McpServerSpec;
}

export interface ConnectOptions {
  /**
   * どちらで繋ぐか。既定は遠く（npm が要らない）。
   * 遠くが駄目だったときだけ `local`。
   */
  prefer?: 'remote' | 'local';
  /** 場所を渡す道具に入れる、いまの作業場。 */
  root?: string;
  /** 合言葉。名前 → 値。**渡された分だけ**置き場の .env に書く。 */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

/** 繋ぐ。書くところまでで、立ち上げるのは次に土台を組むとき。 */
export async function connectService(id: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const entry = findEntry(id);
  if (!entry) {
    return {
      ok: false, missing: [], notes: [],
      error: `見本帳にありません: ${id}（在るもの: ${CATALOG.map((e) => e.id).join(', ')}）`,
    };
  }
  try {
    for (const sec of entry.secrets ?? []) {
      const value = opts.secrets?.[sec.env];
      if (typeof value !== 'string' || value.trim() === '') continue;
      await writeEnvValue(join(aasHome(), '.env'), sec.env, value.trim());
      process.env[sec.env] = value.trim();
    }

    const spec: Record<string, unknown> = {
      ...specFrom(entry, { ...(opts.root ? { root: opts.root } : {}), ...(opts.prefer ? { prefer: opts.prefer } : {}) }),
      enabled: opts.enabled !== false,
    };
    // 同梱してあるなら、そちらで起こす（npx の無い機械でも動く）。
    if (entry.id === 'github-local') {
      const launch = githubLaunch();
      spec.command = launch.command;
      spec.args = launch.args;
    }
    const path = await saveMcpServer(entry.id, spec as Parameters<typeof saveMcpServer>[1]);
    return {
      ok: true, id: entry.id, path, spec: spec as McpServerSpec,
      missing: missingSecrets(entry).map((m) => ({ env: m.env, about: m.about, ...(m.where ? { where: m.where } : {}) })),
      notes: notesFor(entry, opts.prefer),
      };
  } catch (e) {
    return { ok: false, missing: [], notes: [], error: (e as Error).message };
  }
}

/** 外す。設定から消すだけ。合言葉は残す（繋ぎ直すたびに打ち直させない）。 */
export async function disconnectService(id: string): Promise<ConnectResult> {
  const entry = findEntry(id);
  const name = entry?.id ?? id;
  try {
    const { path, removed } = await removeMcpServer(name);
    // **繋がっていないものを「外しました」と言わない。**
    if (!removed) {
      return { ok: false, id: name, path, missing: [], notes: [], error: `繋がっていません: ${name}` };
    }
    return { ok: true, id: name, path, missing: [], notes: [] };
  } catch (e) {
    return { ok: false, missing: [], notes: [], error: (e as Error).message };
  }
}

function notesFor(entry: CatalogEntry, prefer?: 'remote' | 'local'): string[] {
  const notes: string[] = [];
  if (entry.retired) notes.push(entry.retired);
  // **確かめていないことは、確かめていないと言う。**
  if (entry.unverified && prefer !== 'local') {
    notes.push('この繋ぎ先はこちらの見当です（確かめていません）。'
      + '繋がらなければ「手元で動かす」を試してください。');
  }
  if (needsNpx(entry, prefer) && !canRun('npx')) {
    notes.push('この道具は npx で立ち上げます。この機械には npm が入っていないので、動きません。');
  }
  return notes;
}
