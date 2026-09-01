/**
 * 口が開かなかったときに、黙って固まらないこと。
 *
 * `listen` の `error` を拾い忘れると、約束は resolve も reject も
 * されない。**失敗と言うのでもなく、永久に返らない。**
 * 三か所で同じ書き方をしていたので、一つにまとめて検査もここに置く。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { listenOrExplain, listenMessage, boundPort } from '../src/core/listen.ts';

/** 口を一つ塞いでおく。 */
async function occupy(): Promise<{ port: number; free: () => Promise<void> }> {
  const s = createServer(() => {});
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: boundPort(s, 0),
    free: () => new Promise<void>((r) => { s.close(() => r()); }),
  };
}

const opened: Server[] = [];
function fresh(): Server {
  const s = createServer(() => {});
  opened.push(s);
  return s;
}
test.afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
});

describe('口を開ける', () => {
  test('0 を渡すと、決まった番号が返る', async () => {
    const port = await listenOrExplain(fresh(), { port: 0, what: '試し' });
    assert.ok(port > 0, '番号が返っていない');
  });

  test('塞がっていたら、待たずに理由が返る', async () => {
    const taken = await occupy();
    try {
      // 固まる作りだと、ここで検査そのものが時間切れになる。
      await assert.rejects(
        () => listenOrExplain(fresh(), { port: taken.port, what: 'モデル' }),
        (e: Error) => e.message.includes('モデル')
          && e.message.includes(String(taken.port))
          && e.message.includes('既に使われて'),
      );
    } finally { await taken.free(); }
  });

  test('塞がっているとき、次の一手まで言う', () => {
    const msg = listenMessage({ port: 4174, what: '画面' }, Object.assign(
      new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' },
    ));
    // 番号だけ言われても、利用者には打つ手がない。
    assert.match(msg, /もう一つ立ち上がって/);
    assert.match(msg, /開いているほう/);
  });

  test('塞がり以外は、理由をそのまま添える', () => {
    const msg = listenMessage({ port: 80, what: '画面' }, Object.assign(
      new Error('listen EACCES'), { code: 'EACCES' },
    ));
    assert.match(msg, /許可がありません/);
    assert.doesNotMatch(msg, /もう一つ/, '違う理由に、塞がりの説明を付けない');
  });
});
