/**
 * 落ちたら、歩幅を狭めて、段に割って進む。
 *
 * ここまでは、落ちたら**同じ大きさで挑み直して**いた。
 * 通らなかったものを、もう一度そのまま渡しても通らない。
 * 三回やって諦める、を繰り返すだけだった。
 *
 * ここで見るのは、**二度目が一度目と違う形で来ること**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './until.ts';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { UnfinishedWork } = await import('../src/core/unfinished.ts');
const { StrideBook } = await import('../src/agent/stride.ts');

/**
 * 段に割るときは段を返し、それ以外は「道具を呼んで、合図なしで止まる」。
 * **渡された決まり（system）で見分ける。**中身で見分けると、
 * 割る側と働く側の区別が付かない。
 */
async function fakeModel(onAsk: (text: string) => void) {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = JSON.parse(body || '{}') as { messages: { role: string; content: string }[] };
      const system = p.messages.find((m) => m.role === 'system')?.content ?? '';
      const last = p.messages.at(-1)?.content ?? '';
      onAsk(last);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const say = (t: string) => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      };
      if (system.includes('一歩ずつ実行できる段')) {
        say('src/a.ts を読む\n型を string に直す\nnpm test を走らせる');
      } else if (p.messages.some((m) => m.role === 'tool')) {
        // 道具の結果は返ってきたが、**合図を書かずに止まる。**
        say('では、このあと直します。');
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

describe('二度目は、同じ大きさで挑まない', () => {
  test('落ちた依頼は、段に割られて一段ずつ来る', async () => {
    const state = await tempDir('aas-ada-state-');
    process.env.AAS_STATE_DIR = state;
    const root = await tempDir('aas-ada-root-');

    const asked: string[] = [];
    const fake = await fakeModel((t) => asked.push(t));
    const s = new UiServer({
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        runtime: { kind: 'ollama' }, // 偽の相手（openai 互換）へ繋ぐ。既定（inproc）だと GGUF を探しに行く
        candidates: ['p:m'],
        agent: { root, approval: 'auto' },
      } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      // 一度目。丸ごと渡して、落ちる。
      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'src を直して' }),
      });
      const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
      let item;
      for (let i = 0; i < 300; i += 1) {
        item = (await store.list()).find((u) => u.request === 'src を直して');
        if (item) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(item, '落ちたのに控えていない');

      // 一度目は「丸ごと」渡っていること。
      assert.ok(asked.some((a) => a.includes('src を直して')), '一度目の依頼が渡っていない');

      // **二度目**。時が来たことにして、こちらから拾わせる。
      await store.bump(item.id, Date.now() - 60 * 60_000);
      const before = asked.length;
      const session = await s.session();
      assert.equal(await s.idleTick(session), 'RESUMED');

      // 一段ぶんが**終わり切る**まで待つ。送った時点で見に行くと、
      // 結果を書き戻す前の姿を見てしまう。
      for (let i = 0; i < 400; i += 1) {
        const g = await (await fetch(`${base}/api/goals`)).json() as {
          list: { request: string; steps: { state: string; attempts: number }[] }[];
        };
        const mine = g.list.find((x) => x.request === 'src を直して');
        if (mine && mine.steps.some((st) => st.attempts > 0 || st.state !== 'pending')) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const second = asked.slice(before);
      // **ここが要点。**丸ごとではなく、段の一つが来ていること。
      assert.ok(
        second.some((a) => a.includes('src/a.ts を読む') && a.includes('ほかの段には手を出さない')),
        `段に割られていない: ${JSON.stringify(second.slice(0, 3))}`,
      );
      assert.ok(second.some((a) => a.includes('1/3')), '何段目かが渡っていない');

      // 段取りが残っていること（次の見回りで、次の段へ進む）。
      const goals = await (await fetch(`${base}/api/goals`)).json() as {
        list: { request: string; steps: { instruction: string }[] }[];
      };
      const goal = goals.list.find((g) => g.request === 'src を直して');
      assert.ok(goal, `段取りが残っていない: ${JSON.stringify(goals)}`);
      assert.equal(goal.steps.length, 3);

      // **歩幅が狭まっていること。**通らなかったのに広いままなら、測っていない。
      const book = new StrideBook(join(state, 'stride.json'));
      const all = await book.all();
      const rec = Object.values(all)[0];
      assert.ok(rec, `歩幅を測っていない: ${JSON.stringify(all)}`);
      assert.equal(rec.size, 'tiny', `落ちたのに狭めていない: ${JSON.stringify(rec)}`);
    } finally { await s.stop(); await fake.close(); }
  });
});

describe('段取りの終わり方', () => {
  /** 段取りだけを直に組んで、終わりの筋を見る。 */
  async function endWith(states: ('done' | 'blocked')[]) {
    const state = await tempDir('aas-end-');
    process.env.AAS_STATE_DIR = state;
    const root = await tempDir('aas-end-root-');
    const { Goals } = await import('../src/core/goals.ts');
    const goals = new Goals(join(state, 'goals.jsonl'));
    const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));

    const goal = await goals.open('src を直して', states.map((_, i) => `段${i}`));
    for (const [i, st] of states.entries()) {
      if (st === 'done') await goals.succeed(goal.id, goal.steps[i]!.id);
      else await goals.block(goal.id, goal.steps[i]!.id);
    }
    const item = (await store.add({ request: 'src を直して', why: 'noProgress', note: 'x' }))!;
    // 時が来たことにする。
    await store.bump(item.id, Date.now() - 60 * 60_000);

    const asked: string[] = [];
    const fake = await fakeModel((t) => asked.push(t));
    const s = new UiServer({
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        runtime: { kind: 'ollama' }, // 偽の相手（openai 互換）へ繋ぐ。既定（inproc）だと GGUF を探しに行く
        candidates: ['p:m'],
        agent: { root, approval: 'auto' },
      } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    const base = (await s.start()).replace(/\/$/, '');
    const session = await s.session();
    const tick = await s.idleTick(session);
    return { s, fake, base, asked, tick, store, item };
  }

  test('全部通ったら、やり残しも片づく', async () => {
    const r = await endWith(['done', 'done']);
    try {
      assert.equal(r.tick, 'RESUMED');
      assert.deepEqual(await r.store.list(), [], 'やり残しが残っている');
      // 丸ごと投げ直していないこと。
      assert.ok(!r.asked.some((a) => a.includes('前回の続きです')), '丸ごと投げ直している');
    } finally { await r.s.stop(); await r.fake.close(); }
  });

  test('手が付かなかった段があるなら、丸ごと投げ直さない', async () => {
    // 割っても通らなかったものを、まとめて渡せば通る道理がない。
    // ここで諦め、何が出来て何が出来なかったかを言う。
    const r = await endWith(['done', 'blocked']);
    try {
      assert.equal(r.tick, 'RESUMED');
      assert.ok(
        !r.asked.some((a) => a.includes('前回の続きです')),
        `通らないと分かっている道へ落ちている: ${JSON.stringify(r.asked)}`,
      );
      // 控えからも外れていること（際限なく蒸し返さない）。
      assert.deepEqual(await r.store.list(), [], '諦めたのに控えが残っている');
    } finally { await r.s.stop(); await r.fake.close(); }
  });
});

describe('通った段の次は、待たずに次へ', () => {
  test('一段ごとに見回りを待たない', async () => {
    // 一段ごとに30秒待つと、10段の段取りで待ち時間だけ5分になる。
    // 通った段の次は、そのまま次へ進むこと。
    const state = await tempDir('aas-chain-');
    process.env.AAS_STATE_DIR = state;
    const root = await tempDir('aas-chain-root-');
    const { Goals } = await import('../src/core/goals.ts');
    const goals = new Goals(join(state, 'goals.jsonl'));
    const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
    await goals.open('src を直して', ['一段目', '二段目', '三段目']);
    const item = (await store.add({ request: 'src を直して', why: 'noProgress', note: 'x' }))!;
    await store.bump(item.id, Date.now() - 60 * 60_000);

    // 道具を1つ呼んで、合図まで書く＝通る段。
    const asked: string[] = [];
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[{"id":"m"}]}');
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = JSON.parse(body || '{}') as { messages: { role: string; content: string }[] };
        const last = p.messages.at(-1)?.content ?? '';
        asked.push(last);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // 直前が道具の結果なら、合図を書いて終わる。そうでなければ道具を呼ぶ。
        if (p.messages.at(-1)?.role === 'tool') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'やりました。\nTASK_DONE\n' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    const s = new UiServer({
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['m'] }],
        runtime: { kind: 'ollama' }, // 偽の相手（openai 互換）へ繋ぐ。既定（inproc）だと GGUF を探しに行く
        candidates: ['p:m'],
        agent: { root, approval: 'auto' },
      } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const session = await s.session();
      // **見回りは一度だけ。**あとは自分で次へ進むこと。
      assert.equal(await s.idleTick(session), 'RESUMED');
      /*
       * **回数で待たない。**400 回 × 50ms＝20 秒で切っていたので、
       * この機械では通り、**配る先（Windows）では落ちた**。落ちたのは
       * 遅かっただけで、待たずに次へ進んでいないことの証拠ではない。
       * 起きるまで見る／上限で諦める、に直す。
       */
      await until(async () => {
        const g = await (await fetch(`${base}/api/goals`)).json() as {
          list: { steps: { state: string }[] }[];
        };
        const mine = g.list.find((x) => x.steps.length === 3);
        if (!mine) return true; // 全部済んで閉じた
        return mine.steps.every((st) => st.state === 'done');
      }, '三段とも済む', { timeoutMs: 180_000, everyMs: 50 });
      const asked3 = asked.filter((a) => a.includes('ほかの段には手を出さない'));
      assert.ok(
        asked3.some((a) => a.includes('三段目')),
        `見回り一度で三段目まで行っていない: ${JSON.stringify(asked3.map((a) => a.slice(0, 40)))}`,
      );
    } finally {
      await s.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => { server.close(() => r()); });
    }
  });
});
