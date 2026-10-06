/**
 * 外の道具（MCP）に、会話から繋ぐ。
 *
 * 繋ぎ方は決まっているのに、繋ぐたびに設定ファイルを開かせていた。
 * **「GitHub と繋いで」で繋がる**ようにする。
 *
 * 合言葉は**受け取らない。**会話に打たせると、やりとりの記録に残り、
 * 送った先（モデル）にも渡る。要るときは「これが要る」と言って、
 * 画面（設定 → 外の道具）で入れてもらう。
 */
import { CATALOG, BUILTIN, findEntry, missingSecrets, needsNpx } from '../../mcp/catalog.ts';
import { connectService, disconnectService } from '../../core/mcp-connect.ts';
import { type Tool, ok, fail, requireString } from './types.ts';
import type { McpServerSpec } from '../../mcp/client.ts';
import { savedMcpServers } from '../../ui/settings.ts';

/**
 * 繋ぎ先が変わったことを、**いま動いているセッションへ伝える口。**
 *
 * ここまで、繋ぐ・外すは設定ファイルを書き換えるだけだった。動いている側の
 * 相手の一覧（`mcpClients`）は `Session.create` のときに作ったきり作り直さない
 * ので、**外してもツールは呼べたまま**、**繋いでも次の依頼では使えない**。
 * それでいて「次の依頼から使えます」「次の依頼からは出てきません」と言っていた。
 * 渡されなければ、これまでどおり設定を書くだけ（試験や CLI から直に使う道）。
 */
export interface ServiceHooks {
  /** 繋いだ相手を起こして、ツールに足す。足せたかを返す。 */
  onConnected?(id: string, spec: McpServerSpec): Promise<boolean>;
  /** 外した相手を止めて、ツールから外す。外せたかを返す。 */
  onDisconnected?(id: string): boolean;
  /** いま動いている相手の名前（一覧に「動いている」と出すため）。 */
  running?(): string[];
}

export function createListServicesTool(hooks: ServiceHooks = {}): Tool {
  return {
  ...listServicesTool,
  async run(args, ctx) {
    const base = await listServicesTool.run(args, ctx);
    // 設定に在るか・止めてあるか・動いているかを添える（言わないと、繋がっているものを繋ぎ直して、利用者が置いた形を上書きした）
    const saved = await savedMcpServers();
    const live = new Set(hooks.running?.() ?? []);
    const rows = Object.entries(saved).map(([id, spec]) => {
      const state = live.has(id) ? '動いている' : spec.enabled === false ? '止めてある' : '設定に在る（まだ起きていない）';
      const how = typeof spec.url === 'string' ? '遠くの口' : typeof spec.command === 'string' ? '手元で動かす' : '形が不明';
      return `- ${id}: ${state}（${how}）`;
    });
    if (rows.length === 0) return base;
    return ok(`${base.content}\n\nいま設定に在るもの（繋ぎ直さない。止めてあるものは画面で入れてもらう）:\n${rows.join('\n')}`);
  },
  };
}

export const listServicesTool: Tool = {
  schema: {
    name: 'list_services',
    description:
      '元から入っている機能と、外に繋げる先の一覧。'
      + '繋ぐ前に、まずこれを見る（持っているものを繋ぎ直さないため）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run() {
    // **元から在るものを先に言う。**言わないと、持っている機能を
    // わざわざ外から繋ぎ直そうとする。
    const have = BUILTIN.map((b) => `- ${b.name}: ${b.about}（${b.tools.join(', ')}）`);
    const lines = CATALOG.map((e) => {
      const missing = missingSecrets(e).map((m) => m.env);
      const mark = [
        e.url ? '遠く（npm は要らない）' : '手元',
        ...(needsNpx(e) ? ['npm が要る'] : []),
        ...(e.unverified ? ['繋ぎ先は未確認'] : []),
        ...(e.retired ? ['廃止'] : []),
        ...(missing.length > 0 ? [`合言葉が要る: ${missing.join(', ')}`] : []),
      ].join(' / ');
      return `- ${e.id}（${e.name}）: ${e.about} [${mark}]`;
    });
    return ok([
      '元から入っているもの（繋ぐ必要はない）:', ...have,
      '', '外に繋げる先:', ...lines,
    ].join('\n'));
  },
};

export function createConnectServiceTool(hooks: ServiceHooks = {}): Tool {
  return {
    schema: {
      name: 'connect_service',
      description:
        '外の道具（MCP）に繋ぐ。list_services に在る id を渡す。'
        + '合言葉はここでは受け取らない（要るときは、何が要るかを返す）。'
        + '繋いだものは、次の依頼から使える。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '繋ぎ先の id（例: github, playwright）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const id = requireString(args, 'id');
      if (!id) return fail('id が必要です。list_services で一覧を見てください。');
      const entry = findEntry(id);
      if (!entry) {
        return fail(`そういう繋ぎ先はありません: ${id}（在るもの: ${CATALOG.map((e) => e.id).join(', ')}）`);
      }
      // もう設定に在るものは書き直さない（利用者が手元で動かす形にした・止めておいたものを、カタログの形と「入」で丸ごと上書きしていた）
      const already = (await savedMcpServers())[entry.id];
      if (already) {
        return ok(already.enabled === false
          ? `${entry.name}（${entry.id}）は設定に在りますが、止めてあります。入れるかどうかは、利用者に画面（設定 → 外のツール）で決めてもらってください。`
          : `${entry.name}（${entry.id}）は、もう設定に在ります。繋ぎ直しはしません。`);
      }

      // **外と繋ぐのは、勝手にやらない。**利用者の合言葉が動く話なので、
      // 承認を通す（自動で通す設定でも、協議は必ず人に見せる）。
      const answer = await ctx.approve({
        kind: 'deliberation',
        summary: `外の道具に繋ぎます: ${entry.name}（${entry.id}）\n${entry.about}`,
      });
      if (answer === false) return fail(`利用者が断りました: ${entry.name}`);

      const got = await connectService(entry.id, { root: ctx.root });
      if (!got.ok) return fail(got.error ?? '繋げませんでした');

      /*
       * **「次の依頼から使えます」を、本当にする。**
       *
       * ここまでは設定を書くだけで、動いている側には何も足していなかった。
       * 次の依頼どころか、立ち上げ直すまで使えない。
       */
      const up = got.spec && hooks.onConnected
        ? await hooks.onConnected(entry.id, got.spec).catch(() => false)
        : undefined;
      const said = [
        up === false
          ? `設定に書きました: ${entry.name}（${entry.id}）。ただし、いま起こすことはできませんでした`
            + '（立ち上げ直すと繋がることがあります）。'
          : up === true
            ? `繋ぎました: ${entry.name}（${entry.id}）。次の依頼から使えます。`
            // 動いているセッションが無い所（画面を通さない道）では、書いたところまでを言う。
            : `設定に書きました: ${entry.name}（${entry.id}）。次に立ち上げたときから使えます。`,
      ];
      for (const m of got.missing) {
        said.push(`合言葉が要ります: ${m.env}（${m.about}）。設定 → 外の道具 で入れてください。`);
      }
      said.push(...got.notes);
      return ok(said.join('\n'));
    },
  };
}

export function createDisconnectServiceTool(hooks: ServiceHooks = {}): Tool {
  return {
    schema: {
      name: 'disconnect_service',
      description: '外の道具（MCP）を外す。合言葉は消さない。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '外す id' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const id = requireString(args, 'id');
      if (!id) return fail('id が必要です。');
      const answer = await ctx.approve({ kind: 'deliberation', summary: `外の道具を外します: ${id}` });
      if (answer === false) return fail(`利用者が断りました: ${id}`);
      const got = await disconnectService(id);
      // 繋がっていないものを「外しました」と言わない（打ち間違いが事実として返る）。
      if (!got.ok) return fail(got.error ?? '外せませんでした');
      /*
       * **止めるところまでやる。**設定から消すだけでは、動いている相手は
       * そのまま立っていて、ツールも呼べたままになる。
       */
      const down = hooks.onDisconnected?.(got.id ?? id);
      return ok(down === false
        ? `設定から外しました: ${id}。いま動いている分は、立ち上げ直すまで残ります。`
        : `外しました: ${id}。次の依頼からは出てきません。`);
    },
  };
}
