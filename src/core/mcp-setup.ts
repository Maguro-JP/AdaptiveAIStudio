/**
 * 外の相手（MCP）を起こす。**待たない。**
 *
 * ここは全部が繋がるまで待っていた。1台につき最大20秒（初期化と一覧で
 * 各10秒）。その間 `Session.create` が止まり、**最初の送信がそのぶん
 * 待たされる。**利用者は何も悪いことをしていない。相手が黙っているだけ。
 *
 * 起こすのは始めるが、待つのはやめる。繋がった相手のツールは、
 * 繋がった時点で足す（`onReady`）。最初の1ターンに間に合わなければ、
 * その1ターンだけツールが少ない。**待たせるよりよい。**
 */
import type { AasConfig } from '../config.ts';
import { McpClient, type McpServerSpec } from '../mcp/client.ts';
import { deliverableCount } from '../mcp/tools.ts';

export async function startMcpServers(
  config: AasConfig,
  log?: (level: 'info' | 'warn', text: string) => void,
  onReady?: () => void,
): Promise<McpClient[]> {
  const cfg = config.mcp ?? {};
  if (cfg.enabled === false) return [];

  const entries = Object.entries(cfg.servers ?? {}).filter(([, s]) => s.enabled !== false);
  if (entries.length === 0) return [];

  const clients = entries.map(([name, spec]) => new McpClient(name, spec));

  // 起こすだけ起こして、**待たずに返す。**
  for (const c of clients) {
    void c.start().then((okay) => {
      if (okay) {
        log?.('info', `外のツールに繋がりました: ${c.name}（${deliverableCount(c)} 件）`);
        onReady?.();
      } else {
        log?.('warn', `外のツールに繋がりませんでした: ${c.name} — ${c.failure ?? '理由は不明'}`);
      }
    }).catch(() => undefined);
  }

  return clients;
}

/**
 * 繋ぐ（画面・`connect_service`）。いま動いている相手の一覧にも効かせる。
 *
 * 同じ名前が在っても立ち上げ直す。名前が在るだけで「繋ぎました」と返していたので、立ち上げのときに繋がらなかった相手
 * （API キーを入れる前に起こした等）は、キーを入れて繋ぎ直しても立ち上げ直すまでツールが 0 件のままだった。動いている相手も、
 * キーは起こすとき（`envFrom`）・名乗るとき（`headersFrom`）に一度だけ読むので、入れ替えたキーが効かなかった。
 * 立たなかったものは一覧に残さない（ツールは出ないが、外せなくなる）。
 */
export async function connectInto(
  clients: McpClient[], id: string, spec: McpServerSpec,
  log: (level: 'info' | 'warn', text: string) => void, refresh: () => void,
): Promise<boolean> {
  // 新しい相手を先に起こし、起きてから入れ替える。先に古い相手を止めると、入れたキーの綴り違い・一瞬の繋がらなさで
  // 起こせなかったときに、それまで動いていたツールまで消えた
  const client = new McpClient(id, spec);
  const up = await client.start().catch(() => false);
  if (!up) {
    client.stop();
    const kept = clients.some((c) => c.name === id && c.running);
    log('warn', `外のツールに繋がりませんでした: ${id} — ${client.failure ?? '理由は不明'}${kept ? '（前の繋がりのまま使います）' : ''}`);
    return false;
  }
  const before = clients.findIndex((c) => c.name === id);
  if (before >= 0) {
    clients[before]!.stop();
    clients.splice(before, 1, client);
  } else {
    clients.push(client);
  }
  log('info', `外のツールに繋がりました: ${id}（${deliverableCount(client)} 件）`);
  refresh();
  return true;
}
