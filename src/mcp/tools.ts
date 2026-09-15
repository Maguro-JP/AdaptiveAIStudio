/**
 * 外の道具を、この場所の道具として配る。
 *
 * 繋ぐこと自体は難しくない。難しいのは**繋いだ先をどう扱うか**で、
 * ここを雑にすると、外から来た文字がそのまま手元の判断材料になる。
 *
 *   ・返ってきた中身は「外から入ってきたもの」。検問所を通す
 *   ・止めたら、中身は渡さない
 *   ・道具は権限として配る（役職が mcp を持っていなければ渡らない）
 *
 * 名前は `<サーバ名>__<道具名>` にする。相手が同じ名前の道具を
 * 持っていても、ぶつからないようにするため。
 */
import { type Tool, ok, fail } from '../agent/tools/types.ts';
import { inspectInbound, describeVerdict } from '../harness/gate.ts';
import { type Inspector, combine } from '../harness/inspector.ts';
import type { McpClient } from './client.ts';

/** 名前の区切り。モデルが呼びやすいよう、記号は使わない。 */
export const SEPARATOR = '__';

export function toolName(server: string, tool: string): string {
  return `${server}${SEPARATOR}${tool}`;
}

/**
 * 一つの MCP 道具を、この場所の道具にする。
 *
 * 呼び出しの引数は、相手が出してきた schema をそのまま渡す。
 * こちらで作り直すと、相手が受け付ける形からずれる。
 */
export function wrapTool(
  client: McpClient,
  spec: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  opts: { inspector?: Inspector; timeoutMs?: number } = {},
): Tool {
  return {
    schema: {
      name: toolName(client.name, spec.name),
      description: spec.description
        ? `[${client.name}] ${spec.description}`
        : `[${client.name}] ${spec.name}`,
      parameters: spec.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
    },
    async run(args, ctx) {
      // 外の道具を動かすのは、外へ出るのと同じ重さで扱う。
      // 相手が何をするかはこちらからは分からないので、黙って呼ばない。
      const approved = await ctx.approve({
        kind: 'command',
        command: `${client.name} / ${spec.name}  ${JSON.stringify(args).slice(0, 200)}`,
      });
      if (!approved) return fail(`${client.name}/${spec.name} は許可されませんでした。`);

      const r = await client.call(spec.name, args, opts.timeoutMs);
      if (r.isError) return fail(r.text || `${client.name}/${spec.name} が失敗しました。`);

      // 返ってきたものは、外から入ってきたもの。検問所を通す。
      let verdict = inspectInbound(r.text);
      if (verdict.passed && opts.inspector) {
        verdict = combine(
          verdict,
          await opts.inspector.inspect(r.text, 'inbound', ctx.signal),
          'inbound',
        );
      }
      if (!verdict.passed) {
        // 止めた中身は渡さない。「気をつけて読んで」と添えて渡すのは、
        // 渡した時点で読まれている。
        return fail(`${client.name}/${spec.name}\n${describeVerdict(verdict, 'inbound')}`);
      }
      const notes = verdict.findings.length > 0
        ? `${describeVerdict(verdict, 'inbound')}\n\n`
        : '';
      return ok(`${notes}${r.text}`);
    },
  };
}

/** 立ち上がっているサーバの道具を、まとめて配れる形にする。 */
export function collectTools(
  clients: readonly McpClient[],
  opts: { inspector?: Inspector; timeoutMs?: number } = {},
): Tool[] {
  const tools: Tool[] = [];
  for (const client of clients) {
    if (!client.running) continue;
    for (const spec of client.tools) tools.push(wrapTool(client, spec, opts));
  }
  return tools;
}

/**
 * いまの繋がり具合を、人に見せる形にする。
 *
 * **繋がらなかったものを黙らせない。**道具が出てこない理由が
 * 「設定していない」のか「立ち上がらなかった」のかは、まるで違う。
 */
export function describeServers(clients: readonly McpClient[]): string {
  if (clients.length === 0) {
    return '外の道具は繋いでいません（設定の mcp.servers に足せます）。';
  }
  const lines: string[] = [];
  for (const c of clients) {
    if (c.running) {
      lines.push(`  ✓ ${c.name}  道具 ${c.tools.length} 件`);
    } else {
      lines.push(`  ✗ ${c.name}  ${c.failure ?? '立ち上がっていません'}`);
    }
  }
  return lines.join('\n');
}
