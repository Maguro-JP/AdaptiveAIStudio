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
import { McpClient } from '../mcp/client.ts';

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
        log?.('info', `外のツールに繋がりました: ${c.name}（${c.tools.length} 件）`);
        onReady?.();
      } else {
        log?.('warn', `外のツールに繋がりませんでした: ${c.name} — ${c.failure ?? '理由は不明'}`);
      }
    }).catch(() => undefined);
  }

  return clients;
}
