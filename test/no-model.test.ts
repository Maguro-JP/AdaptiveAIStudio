/**
 * モデルが無くても、画面は開く。
 *
 * `Session.create` は候補が空のとき `throw` していた。土台を作るのは
 * 画面のほとんどの入口（提案・当番・戻す・会話の一覧）なので、
 * **GGUF が一つ無いだけで、画面じゅうが 500 になっていた。**
 * 設定を開くこともできないので、「モデルが無い」を直しに行く手段まで
 * 同時に塞がっていた。利用者は実際にそこで止まった。
 *
 * モデルが要るのは、送る・段取る・考えごとの三つだけ。
 * **要る所で断る。**それ以外は動く。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

// 記録の保存先を、試験専用の場所へ移してから読み込む。
const dir = await tempDir('aas-nomodel-');
process.env.AAS_STATE_DIR = dir;

const { Session } = await import('../src/core/session.ts');
const { UiServer } = await import('../src/ui/server.ts');

/** モデルが一つも無い設定。繋ぎ先も置かないので、外へは行かない。 */
async function config() {
  return {
    providers: [],
    candidates: [],
    runtime: { kind: 'none' },
    agent: { root: await tempDir('aas-nomodel-root-'), approval: 'auto', verify: { enabled: false } },
    initiative: { enabled: false },
  } as never;
}

describe('モデルが無いとき、土台は作れる', () => {
  test('**作れる。投げない**', async () => {
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    assert.ok(session, '土台が作れていない');
    await session.close();
  });

  test('モデルが要らない所は、そのまま使える', async () => {
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    // 提案・当番・暇の配分は、モデルを使わずに読める。画面がここを読む。
    assert.deepEqual(session.proposals.open(), []);
    assert.ok(Array.isArray(session.duties.status(Date.now())));
    assert.ok(session.idle.stats());
    await session.close();
  });

  test('**何が足りないかを、持っている**', async () => {
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    assert.ok(session.noModel, 'モデルが無いのに、無いと言っていない');
    assert.match(session.noModel, /使えるモデルがありません/);
    await session.close();
  });
});

describe('モデルが要る所では、断る', () => {
  test('送りは、断って終わる（黙って固まらない）', async () => {
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    const events: string[] = [];
    for await (const ev of session.send('1+1 は？')) {
      events.push(ev.type);
      if (ev.type === 'log') assert.match(ev.text, /使えるモデルがありません/);
    }
    assert.ok(events.includes('finished'), `終わっていない: ${events.join(',')}`);
    await session.close();
  });

  test('段取りも、断って終わる', async () => {
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    const events: string[] = [];
    for await (const ev of session.plan('直して')) events.push(ev.type);
    assert.ok(events.includes('log'), `何も言わずに終わっている: ${events.join(',')}`);
    await session.close();
  });

  test('考えごとは、始めない。**ただし黙って終わらない**', async () => {
    /*
     * ここは「一つも出さずに終わる」を見ていた。**黙って終わることを守る試験**に
     * なっていて、押した人には何も起きないように見える形をそのまま通していた。
     * 始めないのは正しい。始めない理由を言うところまでを見る。
     * 見せるかどうかは呼ぶ側が決める（見回りは黙り、押されたときだけ出す）。
     */
    const session = await Session.create(await config(), { approve: () => Promise.resolve(true) });
    const gen = session.think();
    const first = await gen.next();
    assert.equal(first.done, false, '理由を言わずに終わっている');
    assert.equal((first.value as { type: string }).type, 'declined');
    assert.match((first.value as { reason: string }).reason, /モデル/);
    const next = await gen.next();
    assert.equal(next.done, true, '考え始めてしまっている');
    assert.equal(next.value, false);
    await session.close();
  });
});

describe('画面の入口が、モデル無しでも答える', () => {
  let server: InstanceType<typeof UiServer>;
  let base = '';

  before(async () => {
    server = new UiServer({ config: await config(), port: 0 });
    base = (await server.start()).replace(/\/$/, '');
  });
  after(async () => { await server.stop(); });

  /**
   * ここが 500 だった。画面は開いた直後にこれを読むので、
   * **利用者から見ると「開いた瞬間に壊れている」。**
   */
  for (const path of ['/api/proposals', '/api/models', '/api/info', '/api/conversations']) {
    test(`${path} が答える`, async () => {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, `${path} が ${r.status}`);
    });
  }

  test('**送りだけは断る。しかも理由を言う**', async () => {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '1+1 は？' }),
    });
    assert.equal(r.status, 503, `断っていない: ${r.status}`);
    const body = await r.json() as { error?: string };
    assert.ok(body.error && body.error.length > 0, '理由を言っていない');
  });
});
