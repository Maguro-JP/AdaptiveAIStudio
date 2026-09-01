/**
 * 外の道具を立ち上げる。
 *
 * **全部を道連れにしない。**一つが立ち上がらなくても、他は使える。
 * そして、立ち上がらなかったことを黙らせない。道具が出てこない理由が
 * 「設定していない」のか「落ちた」のかは、使う側にとってまるで違う。
 */
import type { AasConfig } from '../config.ts';
import { McpClient } from '../mcp/client.ts';

export async function startMcpServers(
  config: AasConfig,
  log?: (level: 'info' | 'warn', text: string) => void,
): Promise<McpClient[]> {
  const cfg = config.mcp ?? {};
  if (cfg.enabled === false) return [];

  const entries = Object.entries(cfg.servers ?? {}).filter(([, s]) => s.enabled !== false);
  if (entries.length === 0) return [];

  const clients = entries.map(([name, spec]) => new McpClient(name, spec));

  // 並べて立ち上げる。順に待つと、遅い相手のぶんだけ起動が遅くなる。
  await Promise.all(clients.map(async (c) => {
    const okay = await c.start();
    if (okay) log?.('info', `外の道具に繋がりました: ${c.name}（${c.tools.length} 件）`);
    else log?.('warn', `外の道具に繋がりませんでした: ${c.name} — ${c.failure ?? '理由は不明'}`);
  }));

  return clients;
}
