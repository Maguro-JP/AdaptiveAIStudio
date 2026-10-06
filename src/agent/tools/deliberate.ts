/**
 * 協議にかける道具。
 *
 * 重大な変更の手前で規則に止められたとき、ここを通す。
 * 通ること自体が目的ではない。案・理由・影響・戻し方を言葉にする過程で
 * 「やらない方がよい」と分かることが、いちばん多い成果になる。
 */
import { type Tool, ok, fail } from './types.ts';
import { canonicalRel } from './paths.ts';
import { type Forum, type Proposal, validateProposal } from '../../harness/deliberation.ts';

export function createDeliberateTool(forum: Forum): Tool {
  return {
    schema: {
      name: 'deliberate',
      description:
        '重大な変更を協議にかける（守りの仕掛けへの変更、広範囲の書き換え）。'
        + '案・理由・影響・戻し方を出す。出したうえで実行する。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '何を変えるか' },
          reason: { type: 'string', description: 'なぜ必要か' },
          impact: { type: 'string', description: '何に影響するか' },
          rollback: { type: 'string', description: '間違いだったとき、どう戻すか' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: '対象ファイル（作業ディレクトリからの相対パス）',
          },
        },
        required: ['subject', 'reason', 'impact', 'rollback', 'paths'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const draft: Partial<Proposal> = {
        subject: str(args.subject),
        reason: str(args.reason),
        impact: str(args.impact),
        rollback: str(args.rollback),
        paths: Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === 'string')
          : undefined,
      };
      const missing = validateProposal(draft);
      if (missing) return fail(missing);

      // 協議は利用者にも見せる。黙って自分で通す形にすると、
      // 「協議した」という記録だけが残って中身が誰にも読まれない。
      const summary = [
        `変更: ${draft.subject}`,
        `理由: ${draft.reason}`,
        `影響: ${draft.impact}`,
        `戻し方: ${draft.rollback}`,
        `対象: ${draft.paths!.join(', ')}`,
      ].join('\n');
      const approved = await ctx.approve({ kind: 'deliberation', summary });
      if (!approved) {
        return fail('協議は通りませんでした。この変更は行わず、別の手を考えてください。');
      }

      // 会話ごとの協議の場が渡されていれば、そちらへ（別の会話の協議で、この会話の変更を通させない）。
      // 道は、書くときに当たる実体の綴りでも残す（絶対の道で協議して相対で書く、の逆向きでも協議が効くように）
      const real = await Promise.all(draft.paths!.map((p) => canonicalRel(ctx.root, p).catch(() => undefined)));
      const paths = [...new Set([...draft.paths!, ...real.filter((p): p is string => p !== undefined)])];
      (ctx.request?.forum ?? forum).add({ ...(draft as Proposal), paths, at: Date.now() });
      return ok(`協議を記録しました。対象への変更を進められます。\n${summary}`);
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
