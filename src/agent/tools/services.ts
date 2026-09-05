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

export const connectServiceTool: Tool = {
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

    // **外と繋ぐのは、勝手にやらない。**利用者の合言葉が動く話なので、
    // 承認を通す（自動で通す設定でも、協議は必ず人に見せる）。
    const answer = await ctx.approve({
      kind: 'deliberation',
      summary: `外の道具に繋ぎます: ${entry.name}（${entry.id}）\n${entry.about}`,
    });
    if (answer === false) return fail(`利用者が断りました: ${entry.name}`);

    const got = await connectService(entry.id, { root: ctx.root });
    if (!got.ok) return fail(got.error ?? '繋げませんでした');

    const said = [`繋ぎました: ${entry.name}（${entry.id}）。次の依頼から使えます。`];
    for (const m of got.missing) {
      said.push(`合言葉が要ります: ${m.env}（${m.about}）。設定 → 外の道具 で入れてください。`);
    }
    said.push(...got.notes);
    return ok(said.join('\n'));
  },
};

export const disconnectServiceTool: Tool = {
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
    if (!got.ok) return fail(got.error ?? '外せませんでした');
    return ok(`外しました: ${id}。次の依頼からは出てきません。`);
  },
};
