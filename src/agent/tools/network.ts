/**
 * 外へ出るための唯一の出口。
 *
 * ここは主義に反するように見えるが、そうではない。
 * この場所の主役はローカルで動く思考であって、外部サービスではない。
 * 外に出るのは「手元をいくら読んでも分からないこと」を確かめるときだけだ。
 * 依存の最新版、既知の不具合、規格の変更 —— 手元には答えが無い。
 *
 * だから出口は一つに絞り、次の三つを守る。
 *
 *   1. 行き先を決め打ちにする（許可リスト。既定はごく少数）
 *   2. 取ってくるだけにする（GET のみ。資格情報は一切送らない）
 *   3. 外れても止まらない（繋がらなければ「行けなかった」と返して先へ進む）
 *
 * 3 が特に重要。外部が落ちていることで手元の作業が止まるなら、
 * それは外部に依存しているのと同じことになる。
 */
import { type Tool, ok, fail, requireString } from './types.ts';

/**
 * 既定の行き先。
 * 「開発の判断に必要で、公開されていて、認証が要らない」ものだけを置く。
 * ニュースサイトや検索エンジンは入れない。雑音を持ち帰らせないため。
 */
export const DEFAULT_ALLOWED_HOSTS = [
  'registry.npmjs.org',   // 依存の実際の最新版
  'api.github.com',       // リリース、既知の不具合
  'raw.githubusercontent.com', // 変更履歴そのもの
  'nodejs.org',           // 実行環境の版と保守期限
  'api.osv.dev',          // 既知の脆弱性
];

export interface NetworkOptions {
  allowedHosts?: string[];
  /** 応答の読み取り上限。長文を丸ごと文脈に入れない。 */
  maxBytes?: number;
  timeoutMs?: number;
  /** 差し替え可能にしておく。試験でも本物の外へは出ない。 */
  fetchImpl?: typeof fetch;
}

export class HostNotAllowed extends Error {}

/** 許可リスト照合。サブドメインは明示されない限り許さない。 */
export function checkHost(url: string, allowed: Set<string>): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HostNotAllowed(`URL として読めません: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new HostNotAllowed(`https のみ許可します: ${parsed.protocol}`);
  }
  if (!allowed.has(parsed.hostname)) {
    throw new HostNotAllowed(
      `行き先が許可されていません: ${parsed.hostname}（許可: ${[...allowed].join(', ')}）`,
    );
  }
  return parsed;
}

/** HTML から本文らしきものを取り出す。整形が目的ではなく、読める量に減らすのが目的。 */
export function toText(body: string, contentType: string): string {
  if (!/html/i.test(contentType)) return body;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createFetchUrlTool(opts: NetworkOptions = {}): Tool {
  const allowed = new Set(opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
  const maxBytes = opts.maxBytes ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    schema: {
      name: 'fetch_url',
      description:
        '公開されている情報を取得する（GET のみ、資格情報は送らない）。'
        + `許可された行き先: ${[...allowed].join(', ')}。`
        + '手元で確認できることは、先に手元で確認すること。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'https の URL' },
          purpose: { type: 'string', description: '何を知りたいのかを一文で' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const url = requireString(args, 'url');
      if (!url) return fail('url が必要です。');

      let target: URL;
      try {
        target = checkHost(url, allowed);
      } catch (e) {
        return fail((e as Error).message);
      }

      // 外へ出ることは書き込みと同じ重さで扱う。黙って出ていかせない。
      const approved = await ctx.approve({ kind: 'network', url: target.toString() });
      if (!approved) return fail(`外部への問い合わせは許可されませんでした: ${target}`);

      const timer = new AbortController();
      const onAbort = () => timer.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const t = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const res = await doFetch(target.toString(), {
          method: 'GET',
          redirect: 'error', // 許可リストの外へ飛ばされないため
          headers: { accept: 'text/plain, application/json, text/html;q=0.8', 'user-agent': 'AdaptiveAIStudio' },
          signal: timer.signal,
        });
        const body = await res.text();
        const type = res.headers.get('content-type') ?? '';
        const text = toText(body, type);
        const clipped = text.length > maxBytes
          ? text.slice(0, maxBytes) + `\n…（以降 ${text.length - maxBytes} 文字は省略）`
          : text;
        if (!res.ok) {
          // 失敗も情報。握り潰すと同じ場所へ何度も行く。
          return ok(`出典: ${target}\n状態: ${res.status} ${res.statusText}\n\n${clipped}`);
        }
        return ok(`出典: ${target}\n\n${clipped}`);
      } catch (e) {
        // ここで例外を投げない。外が落ちていても手元の作業は続く。
        const reason = timer.signal.aborted ? `${timeoutMs}ms で応答が無い` : (e as Error).message;
        return fail(`外に出られませんでした（${reason}）。手元で確認できる範囲で進めてください: ${target}`);
      } finally {
        clearTimeout(t);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
