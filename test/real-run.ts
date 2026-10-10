/**
 * 実走のための、決まった手順で動く「モデル」。
 *
 * これまでの模型（`fake-server.ts`）は、**呼ぶ道具をこちらが書いていた**。
 * 書いた通りに呼ばれるので、通っても「その順に呼べば通る」しか分からない。
 * ここでは道具の結果を**読んでから**次を決める。当たらなければ止まる。
 *
 * 賢さは持たない（それはモデルの仕事）。持つのは
 * 「探す → 読む → 直す → 終わりと言う」の段取りだけ。
 */
import { createServer, type Server } from 'node:http';

interface Wire { role?: string; content?: string; tool_call_id?: string }

export interface RealModel {
  baseUrl: string;
  close(): Promise<void>;
  /** 何をしたか。順に見て、思った通りに動いたかを確かめる。 */
  readonly did: string[];
  /** 届いた本文。**こちらの積もりではなく、渡ったもので見る。** */
  readonly bodies: string[];
}

/**
 * 立てる。
 *
 * @param want  直したい中身。`from` を `to` に差し替えるところまで持っていく。
 */
export async function startRealModel(
  want: { hint: string; from: string; to: string; judge?: 'ok' | 'unreadable' },
): Promise<RealModel> {
  const did: string[] = [];
  const bodies: string[] = [];

  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'real' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { messages?: Wire[]; system?: string } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { /* 空で続ける */ }
      const messages = body.messages ?? [];
      bodies.push([
        body.system ? `system:${body.system}` : '',
        ...messages.map((m) => `${m.role ?? ''}:${m.content ?? ''}`),
      ].filter(Boolean).join('\n'));
      const results = messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const say = (delta: Record<string, unknown>, finish: string | null = null) => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      };
      const call = (name: string, args: Record<string, unknown>) => {
        did.push(name);
        say({ tool_calls: [{ index: 0, id: `call_${results.length + 1}`, function: { name, arguments: JSON.stringify(args) } }] });
        say({}, 'tool_calls');
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const talk = (text: string) => {
        for (const ch of text) say({ content: ch });
        say({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      // 指摘かどうかを判じる問いには、決まった形で返す（本物の代わり）。
      // **合図では拾えない言い方**を渡されても、指摘だと判じる相手にする。
      const asked = messages.filter((m) => m.role === 'user').map((m) => m.content ?? '').join('\n');
      if (/CODE:|指摘・不満・注意かどうか/.test(asked)) {
        // ふつうの依頼なら NONE。指摘なら五行。
        // 読めない返しをする相手も作れる（黙って消えないかを見るため）。
        if (want.judge === 'unreadable') {
          did.push('judge:unreadable');
          return talk('うーん、なんとも言えません');
        }
        const plain = /足し算|直してください$/.test(asked) && !/書けよ|ベストか/.test(asked);
        did.push(plain ? 'judge:none' : 'judge:hit');
        return talk(plain ? 'NONE' : [
          'CODE: REPEATED',
          'WHEN: 覚えの書き方を直していたとき',
          'WHAT: 何に対しての話かを書かなかった',
          'WHY: どの手を選んでも同じ結果、という記録にしかならない',
          'NEXT: 場面から書く',
        ].join('\n'));
      }

      // 1. まず探す。どこを直すかは、こちらでは知らない。
      if (results.length === 0) return call('find_code', { query: want.hint });

      // 探した結果に挙がった道を、順に見ていく。
      // **一発で当てることを前提にしない。**探し物の言葉は試験の側にも
      // 書いてあるので、上位に試験が来ることがある（実際に来た）。
      const candidates = pathsIn(results[0] ?? '');
      if (candidates.length === 0) {
        return talk(`探せませんでした（結果: ${(results[0] ?? '').slice(0, 200)}）`);
      }

      // 直したあとなら、終わりの合図を書く。
      const lastResult = results[results.length - 1] ?? '';
      if (did[did.length - 1] === 'edit_file') {
        if (!/更新|作成/.test(lastResult)) return talk(`直せませんでした（${lastResult.slice(0, 200)}）`);
        return talk('直しました。\nTASK_DONE\n');
      }

      // 読んだものの中に、直す場所が在れば直す。
      const readCount = results.length - 1;
      const seen = results[readCount] ?? '';
      if (readCount >= 1 && seen.includes(want.from)) {
        const at = candidates[readCount - 1];
        if (at) return call('edit_file', { path: at, find: want.from, replace: want.to });
      }

      // 無ければ次の候補を読む。候補が尽きたら、そう言って止まる。
      const next = candidates[readCount];
      if (!next) return talk(`直す場所が見つかりませんでした（見たもの: ${candidates.join(', ')}）`);
      return call('read_file', { path: next });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    did,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 探した結果から、挙がった道を順に拾う（重なりは落とす）。 */
function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)([\w./-]+\.(?:js|mjs|ts|py))\b/gm)) {
    const at = m[1]!;
    if (!out.includes(at)) out.push(at);
  }
  return out;
}
