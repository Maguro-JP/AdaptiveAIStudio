/**
 * 生きているのに「停滞」で落とさない。
 *
 * **Windows のランナーで、本物の重みで落ちた。**足し算（本文だけ）は通り、
 * ツールを渡した回が `inproc が 120秒 応答しませんでした（停滞）` で落ちた。
 * 動いていたのに落としている。
 *
 * 何が起きていたか。
 *
 *   1. 中で読む口（inproc）は、最初の 1 トークンが出るまで `: working` を打つ。
 *      **出た時点で打つのをやめていた。**
 *   2. ツールの呼び出しを組んでいる間、本文は一文字も出ない。
 *      遅い機械では、そこで何分も黙る。
 *   3. 送り側は、最初のトークン以降は**本文かツールの欠片だけ**を進みと数える。
 *      注釈行（`: working`）は数えない。だから 120 秒で停滞と判定した。
 *
 * つまり「黙っている」と「死んでいる」を区別する手立てが、最初のトークンの
 * 後だけ無かった。ここはその区別を留める。
 *
 * **死んでいるものを待ち続けてもいけない。**合図で延ばせるのは上限まで
 * （`quietCeilingMs`、既定は最初のトークンと同じ 10 分）。そこを超えたら、
 * 合図が来ていても停滞と言う。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { Priority } from '../src/providers/contract.ts';

/**
 * 本文を一つ出したあと、注釈行（生存の合図）だけを打ち続ける相手。
 *
 * `quietMs` のあいだ黙ってから、ツールの呼び出しを流して終わる。
 * 実機で起きたことの形（本文 → 長い無音 → ツール）をそのまま作る。
 */
async function quietThenTool(opts: { quietMs: number; beatMs: number; beat: boolean }) {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      };
      // 実機で最初に出たのは空白一つだった（考えごとを 0 にしているため）。
      send({ content: ' ' });
      if (opts.beat) {
        const beat = setInterval(() => { if (!res.writableEnded) res.write(': working\n\n'); }, opts.beatMs);
        beat.unref?.();
        timers.push(beat);
      }
      const done = setTimeout(() => {
        send({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"secret.txt"}' } }] });
        send({}, 'tool_calls');
        res.write('data: [DONE]\n\n');
        res.end();
      }, opts.quietMs);
      done.unref?.();
      timers.push(done as unknown as ReturnType<typeof setInterval>);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => {
      timers.forEach((t) => clearInterval(t));
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

async function collect(baseUrl: string, over: Record<string, number> = {}) {
  const p = new OpenAiCompatibleProvider({
    id: 'inproc', baseUrl, locality: 'local',
    // 実機の比を保ったまま短くする。時間そのものを閾値にした試験にしない。
    stallTimeoutMs: 300, quietCeilingMs: 3000, ...over,
  });
  const out: string[] = [];
  let failed: string | undefined;
  try {
    for await (const ev of p.chat(
      { model: 'm', messages: [{ role: 'user', content: 'secret.txt を読んで' }], priority: Priority.top },
      new AbortController().signal,
    )) {
      if (ev.type === 'text') out.push(ev.delta);
      if (ev.type === 'toolCall') out.push(`tool:${ev.call.name}`);
    }
  } catch (e) {
    failed = (e as Error).message;
  }
  return { out, failed };
}

describe('黙っているのと、死んでいるのを分ける', () => {
  test('**生きている合図が来ている間は、停滞にしない（ツールの呼び出しが届く）**', async () => {
    // 無音 1 秒 > 停滞 0.3 秒。合図を数えていなければ、ここで落ちる。
    const fake = await quietThenTool({ quietMs: 1000, beatMs: 100, beat: true });
    try {
      const got = await collect(fake.baseUrl);
      assert.equal(got.failed, undefined, `生きているのに落としている: ${got.failed}`);
      assert.ok(got.out.includes('tool:read_file'), `ツールの呼び出しが届いていない: ${JSON.stringify(got.out)}`);
    } finally { await fake.close(); }
  });

  test('合図が来ないなら、これまでどおり停滞で落とす（対）', async () => {
    const fake = await quietThenTool({ quietMs: 1000, beatMs: 100, beat: false });
    try {
      const got = await collect(fake.baseUrl);
      assert.match(got.failed ?? '', /応答しませんでした（停滞）/);
    } finally { await fake.close(); }
  });

  test('合図が来ていても、上限を超えたら停滞で落とす（待ち続けない）', async () => {
    // 無音 5 秒 > 上限 3 秒。合図だけで永久に延ばさない。
    const fake = await quietThenTool({ quietMs: 5000, beatMs: 100, beat: true });
    try {
      const got = await collect(fake.baseUrl, { quietCeilingMs: 1000 });
      assert.match(got.failed ?? '', /応答しませんでした/);
    } finally { await fake.close(); }
  });
});
