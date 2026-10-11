/**
 * 流れを開く前・繋ぎ直す間の出来事を、渡し直す（87 回目の調査）。
 *
 * 画面は立ち上げで色々読んでから流れを開く。その間に出た出来事（承認の問い合わせ・作業の始まりと終わり）は、
 * 誰にも届かずに消えていた。繋ぎ直す間も同じで、`Last-Event-ID` を送られても番号を付けていなかった。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-events-replay-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const srv = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, agent: { root: await tempDir('aas-events-work-') } } as typeof DEFAULT_CONFIG });
const url = (await srv.start()).replace(/\/$/, '');
after(async () => { await srv.stop(); });

/** 流れを開き、少し待って届いたものを返す。 */
function read(path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(`${url}${path}`, { headers }, (res) => {
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { got += c; });
      setTimeout(() => { req.destroy(); resolve(got); }, 200);
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
  });
}

async function seq(): Promise<number> {
  return ((await (await fetch(`${url}/api/events/seq`)).json()) as { seq: number }).seq;
}

test('開く前の番号を渡せば、その後に出た出来事が届く', async () => {
  const since = await seq();
  srv.broadcast({ type: 'log', level: 'info', text: '開く前の知らせ' });
  const got = await read(`/api/events?since=${since}`);
  assert.match(got, /開く前の知らせ/, got);
});

test('繋ぎ直しは Last-Event-ID の後から渡し直す（前の分は渡さない）', async () => {
  srv.broadcast({ type: 'log', level: 'info', text: '受け取った分' });
  const last = await seq();
  srv.broadcast({ type: 'log', level: 'info', text: '切れている間の分' });
  const got = await read('/api/events', { 'last-event-id': String(last) });
  assert.match(got, /切れている間の分/, got);
  assert.doesNotMatch(got, /受け取った分/, got);
  assert.match(got, /^id: \d+$/m, '番号を付けていない');
});

test('番号を渡さなければ、これから来る分だけ（対）', async () => {
  srv.broadcast({ type: 'log', level: 'info', text: '前からある分' });
  const got = await read('/api/events');
  assert.doesNotMatch(got, /前からある分/, got);
});
