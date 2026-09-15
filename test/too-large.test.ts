/**
 * 大きすぎるものを断るとき、**断りの文が相手へ届くこと。**
 *
 * `req.destroy()` を先に呼んでいた。あれは socket ごと落とすので、
 * 413 が線に乗らないことがある。添付の口（25MB 超）では実測で
 * **0 バイト**しか返らず、送った側からは黙って切られただけに見えた。
 * 「大きすぎます」と書いてあるのに、誰も読めない。
 *
 * 読むのはやめるが、残りは読み捨てて、返事を書き切ってから閉じる。
 *
 * ここは**本物の socket で確かめる**。`fetch` は途中で切られた側を
 * 例外にしてしまうことがあり、返事が届いたかどうかを見分けにくい。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { UiServer, MAX_JSON_BODY } from '../src/ui/server.ts';
import { MAX_BYTES } from '../src/ui/attachments.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const servers: InstanceType<typeof UiServer>[] = [];
after(async () => { for (const s of servers.splice(0)) await s.stop(); });

async function start(): Promise<{ host: string; port: number }> {
  const dir = await tempDir('aas-big-');
  process.env.AAS_STATE_DIR = dir;
  const s = new UiServer({
    port: 0,
    config: { ...DEFAULT_CONFIG, agent: { root: join(dir, 'work') } } as never,
  });
  servers.push(s);
  const url = new URL(await s.start());
  return { host: url.hostname, port: Number(url.port) };
}

/**
 * 素の socket で、大きすぎる本文を送る。**返ってきたものを全部読む。**
 * 相手が先に返事を書いて閉じても、そこまでは読める。
 */
async function sendTooBig(
  at: { host: string; port: number }, head: string, bytes: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const sock = connect(at.port, at.host, () => {
      sock.write(`${head}content-length: ${bytes}\r\nconnection: close\r\n\r\n`);
      // 少しずつ送る。相手は途中で断るので、最後まで送り切らないことがある。
      const chunk = Buffer.alloc(64 * 1024, 65);
      let sent = 0;
      const push = (): void => {
        while (sent < bytes) {
          const n = Math.min(chunk.length, bytes - sent);
          sent += n;
          if (!sock.write(chunk.subarray(0, n))) { sock.once('drain', push); return; }
        }
      };
      push();
    });
    let got = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { got += d; });
    sock.on('close', () => resolve(got));
    // 書いている途中で相手に閉じられるのは普通。返ってきた分で判じる。
    sock.on('error', () => resolve(got));
    setTimeout(() => { sock.destroy(); reject(new Error('返事が来ない')); }, 60_000).unref?.();
  });
}

describe('大きすぎるものを断るとき、理由が届く', () => {
  test('**添付が上限を超えたら、413 と理由が返る**', async () => {
    const at = await start();
    const got = await sendTooBig(
      at, 'POST /api/attach?name=big.txt HTTP/1.1\r\nhost: localhost\r\n', MAX_BYTES + 2 * 1024 * 1024,
    );
    assert.match(got, /^HTTP\/1\.1 413/, `413 が届いていない: ${JSON.stringify(got.slice(0, 200))}`);
    assert.match(got, /大きすぎます/, got.slice(0, 300));
  });

  test('**JSON の本文が上限を超えても、413 と理由が返る**', async () => {
    const at = await start();
    const got = await sendTooBig(
      at,
      'POST /api/send HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\n',
      MAX_JSON_BODY + 2 * 1024 * 1024,
    );
    assert.match(got, /^HTTP\/1\.1 413/, `413 が届いていない: ${JSON.stringify(got.slice(0, 200))}`);
    assert.match(got, /大きすぎます/, got.slice(0, 300));
  });
});

/**
 * プレビューは、いまの作業場を配ること。
 *
 * 一度立てたものを使い回していた。作業場は後から変えられる（横の 📂・設定）のに、
 * 配っているのは**最初に開いたときの作業場**のまま。返事の `root` は新しい方を
 * 名乗るので、画面は新しい場所を見ている顔をして、中身は前の場所を出す。
 */
describe('プレビューは、いまの作業場を配る', () => {
  test('**作業場を変えたら、配る中身も変わる**', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = await tempDir('aas-pv-');
    const w1 = join(dir, 'w1');
    const w2 = join(dir, 'w2');
    await mkdir(w1, { recursive: true });
    await mkdir(w2, { recursive: true });
    await writeFile(join(w1, 'index.html'), '<h1>ONE</h1>');
    await writeFile(join(w2, 'index.html'), '<h1>TWO</h1>');
    process.env.AAS_STATE_DIR = dir;
    process.env.AAS_CONFIG = join(dir, 'aas.config.json');

    const s = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, agent: { root: w1 } } as never });
    servers.push(s);
    const base = (await s.start()).replace(/\/$/, '');

    const first = await fetch(`${base}/api/preview`).then((x) => x.json()) as { url: string; root: string };
    assert.equal(first.root, w1);
    assert.match(await fetch(first.url).then((x) => x.text()), /ONE/);

    const moved = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workRoot: w2 }),
    });
    assert.equal(moved.status, 200, await moved.text());

    const second = await fetch(`${base}/api/preview`).then((x) => x.json()) as { url: string; root: string };
    assert.equal(second.root, w2, '名乗りが変わっていない');
    const body = await fetch(second.url).then((x) => x.text());
    assert.match(body, /TWO/, `前の作業場を配っている: ${body.slice(0, 120)}`);
    assert.doesNotMatch(body, /ONE/, body.slice(0, 120));
  });
});

/**
 * 止めたら、配る口も閉じる。
 *
 * ここは閉じていなかった。一度プレビューを開くと、画面を止めてもその口が
 * 立ったままになり、**プロセスが終わらない**。同じことを inproc で踏んで
 * 直してあるのに、こちらは残っていた。試験の走りが終わらない形で出た。
 */
describe('止めたら、配る口も閉じる', () => {
  test('**画面を止めたあと、プレビューの口は繋がらない**', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = await tempDir('aas-pvstop-');
    const work = join(dir, 'work');
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'index.html'), '<h1>HERE</h1>');
    process.env.AAS_STATE_DIR = dir;
    process.env.AAS_CONFIG = join(dir, 'aas.config.json');

    const s = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, agent: { root: work } } as never });
    const base = (await s.start()).replace(/\/$/, '');
    const { url } = await fetch(`${base}/api/preview`).then((x) => x.json()) as { url: string };
    assert.match(await fetch(url).then((x) => x.text()), /HERE/);

    await s.stop();
    const after = await fetch(url).then(() => 'まだ繋がる').catch(() => '閉じた');
    assert.equal(after, '閉じた', '止めたのに配る口が立ったまま');
  });
});
