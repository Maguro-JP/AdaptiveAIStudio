/**
 * 「いま考えさせる」を押して、何も起きないまま終わらせない。
 *
 * `/api/think` は中身を見る前に 202 を返し、`session.think()` は
 * モデルが無い・間合いが早い・予算切れ、のどれでも**黙って false を返していた**。
 * 割り当ての側（`IdleScheduler.choose`）は理由を必ず組み立てているのに、
 * それを捨てていた。押した人からは、壊れているのか・時間がかかっているのか・
 * 断られたのかが区別できず、何度も押すことになる。
 *
 * 勝手に動く見回りは、これまでどおり黙る（30秒ごとに同じ一行で記録が埋まる）。
 * **押されたときだけ出す。**見せるかどうかは呼ぶ側が決める。
 */
import { createServer, type AddressInfo } from 'node:net';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { UiServer } from '../src/ui/server.ts';
import { Session, type ThinkEvent } from '../src/core/session.ts';
import { loadConfig, type AasConfig } from '../src/config.ts';

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/**
 * モデルが一つも無い一時の場所。**製品と同じ道で設定を読む。**
 *
 * `DEFAULT_CONFIG` を直に渡すと、繋ぎ先の一覧が取れないときに
 * 設定へ書いてある名前で進む道に入り、**モデルが在ることになってしまう。**
 * 利用者が通るのは `loadConfig()` の側なので、そちらを通す。
 */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as AddressInfo;
  await new Promise((ok) => srv.close(ok));
  return port;
}

async function bare(extra: Record<string, unknown> = {}): Promise<{ work: string; config: AasConfig }> {
  const home = await tempDir('aas-think-');
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  const work = join(home, 'work');
  await mkdir(work, { recursive: true });
  await mkdir(join(home, 'models'), { recursive: true });
  await writeFile(process.env.AAS_CONFIG, JSON.stringify({
    // 口は空いているものにする。既定の 4177 だと、同じ機械で開いている画面のモデルに繋ぎ、
    // 「モデルが無い」はずの試験がモデルを見つける（画面を開いたまま回して落ちた）
    runtime: { kind: 'inproc', basePort: await freePort() }, agent: { root: work, approval: 'auto' }, ...extra,
  }, null, 2));
  return { work, config: loadConfig().config };
}

describe('考えなかったときは、理由を言う', () => {
  test('**モデルが無いときは、そう言う（黙って終わらない）**', async () => {
    const { config } = await bare();
    const session = await Session.create(config, { approve: () => Promise.resolve(true) });
    try {
      const seen: ThinkEvent[] = [];
      for await (const e of session.think()) seen.push(e);
      const declined = seen.find((e) => e.type === 'declined');
      assert.ok(declined, `何も言わずに終わっている: ${JSON.stringify(seen)}`);
      assert.match(declined.reason, /モデル/, declined.reason);
    } finally { await session.close(); }
  });

  test('**設定で止めているときも、そう言う**', async () => {
    const { config } = await bare({ candidates: ['inproc:m'], initiative: { enabled: false } });
    const session = await Session.create(config, { approve: () => Promise.resolve(true) });
    try {
      const seen: ThinkEvent[] = [];
      for await (const e of session.think()) seen.push(e);
      assert.ok(seen.some((e) => e.type === 'declined' && /止めています/.test(e.reason)),
        `何も言わずに終わっている: ${JSON.stringify(seen)}`);
    } finally { await session.close(); }
  });
});

describe('押されたときは、画面まで届く', () => {
  test('**/api/think を押すと、断った理由が流れてくる**', async () => {
    const { config } = await bare();
    const server = new UiServer({ port: 0, config });
    servers.push(server);
    const base = (await server.start()).replace(/\/$/, '');

    const ac = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = events.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const r = await fetch(`${base}/api/think`, { method: 'POST' });
    assert.equal(r.status, 202, await r.text());

    // **決め打ちで待たない。**出るまで読む（出なければ上限で諦める）。
    const until = Date.now() + 20_000;
    while (Date.now() < until && !buf.includes('"declined"')) {
      const step = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((res) => { setTimeout(() => res({ value: undefined }), 500); }),
      ]);
      if (step.value) buf += dec.decode(step.value as Uint8Array, { stream: true });
    }
    ac.abort();
    assert.match(buf, /"type":"declined"/, `断った理由が流れてこない:\n${buf.slice(0, 600)}`);
    assert.match(buf, /モデル/, buf.slice(0, 600));
  });
});
