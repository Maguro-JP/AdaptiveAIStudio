/**
 * 見本帳から一つ繋ぐ、という一つの手続き。
 *
 * 画面からも、会話からも、同じものを使う。**二重に書かない。**
 * 二つに書くと、片方だけ直したときに「画面からは繋がるが、
 * 言っても繋がらない」になる。
 */
import { join } from 'node:path';
import { aasHome } from './home.ts';
import { writeEnvValue, setOutsideEnvFile } from './env.ts';
import { saveMcpServer, removeMcpServer, savedMcpServer } from '../ui/settings.ts';
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
  /** `onlyIfAbsent` で、もう在ったので書かなかったときの、在ったもの */
  already?: Record<string, unknown>;
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
  /** 起こせる形のものが設定に在れば書かない（書く直前に錠の中で見る）。在ったものは `ConnectResult.already` に入る */
  onlyIfAbsent?: boolean;
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
    const shadowed: string[] = [];
    for (const sec of entry.secrets ?? []) {
      const value = opts.secrets?.[sec.env];
      if (typeof value !== 'string' || value.trim() === '') continue;
      // 外の環境変数に同じ名前が立っていると、立ち上げ直したときにそちらが勝つ。値は出さずに、そう言う
      if (setOutsideEnvFile(sec.env)) shadowed.push(sec.env);
      await writeEnvValue(join(aasHome(), '.env'), sec.env, value.trim());
      process.env[sec.env] = value.trim();
    }

    // 選び方が来ていなければ、前に保存した形（手元か遠くか）を保つ（繋ぎ直すたびに遠くの形へ戻していた）
    const before = opts.prefer ? undefined : await savedMcpServer(entry.id);
    const prefer = opts.prefer ?? (before && typeof before.command === 'string' && entry.url ? 'local' as const : undefined);
    const spec: Record<string, unknown> = {
      ...specFrom(entry, { ...(opts.root ? { root: opts.root } : {}), ...(prefer ? { prefer } : {}) }),
      enabled: opts.enabled !== false,
    };
    // 同梱してあるなら、そちらで起こす（npx の無い機械でも動く）。
    let launch: ReturnType<typeof githubLaunch> | undefined;
    if (entry.id === 'github-local') {
      launch = githubLaunch();
      spec.command = launch.command;
      spec.args = launch.args;
    }
    let already: Record<string, unknown> | undefined;
    const path = await saveMcpServer(entry.id, spec as Parameters<typeof saveMcpServer>[1],
      opts.onlyIfAbsent ? { onlyIfAbsent: (e) => { already = e; } } : {});
    if (already) return { ok: true, id: entry.id, path, already, missing: [], notes: [] };
    return {
      ok: true, id: entry.id, path, spec: spec as McpServerSpec,
      missing: missingSecrets(entry).map((m) => ({ env: m.env, about: m.about, ...(m.where ? { where: m.where } : {}) })),
      notes: [
        ...notesFor(entry, prefer, launch),
        ...shadowed.map((env) => `環境変数 ${env} が別に立っています。立ち上げ直すと、そちらの値が使われます（ここで入れた値は使われません）`),
      ],
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

function notesFor(entry: CatalogEntry, prefer?: 'remote' | 'local', launch?: { command: string; why?: string }): string[] {
  const notes: string[] = [];
  if (entry.retired) notes.push(entry.retired);
  // **確かめていないことは、確かめていないと言う。**
  if (entry.unverified && prefer !== 'local') {
    notes.push('この繋ぎ先はこちらの見当です（確かめていません）。'
      + '繋がらなければ「手元で動かす」を試してください。');
  }
  // 実際の起こし方で言う（同梱のツールを node で直に起こすのに「npx が無いので動きません」と言い、動くものを動かないと読ませた）
  if (launch?.why) notes.push(launch.why);
  else if ((!launch || launch.command === 'npx') && needsNpx(entry, prefer) && !canRun('npx')) {
    notes.push('この道具は npx で立ち上げます。この機械には npm が入っていないので、動きません。');
  }
  return notes;
}
