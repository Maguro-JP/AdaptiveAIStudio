/**
 * 作業中（承認待ち）でも「終了」は効く。
 *
 * Windows の check-user で、承認待ちのまま /api/quit が 409 で断られ、終われなかった。
 * 終了を押したら、承認待ちを拒否で解き、作業を止め、本体を止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-quit-busy-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('承認待ちの作業中に終了を押しても、断らずに作業を止めて本体が止まる', async () => {
  const fake = await startFakeServer({ kind: 'toolcall', name: 'run_command', args: { command: 'node glob.js' }, then: '終わりました' });
  let stopped: Promise<void> | undefined;
  let approved: boolean | undefined;
  const server: InstanceType<typeof UiServer> = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'ask' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
    onQuit: () => { stopped = server.stop(); },
  });
  const base = (await server.start()).replace(/\/$/, '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (r: Response): Promise<any> => r.json();
  try {
    const events = await fetch(`${base}/api/events`);
    const reader = events.body!.getReader();
    const dec = new TextDecoder();
    void (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (const m of buf.matchAll(/"type":"approvalDone"[^}]*"approved":(true|false)/g)) approved = m[1] === 'true';
        }
      } catch { /* 本体が止まれば切れる */ }
    })();
    const a = await json(await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'glob.js を動かして' }) }));
    assert.equal(a.accepted, true, JSON.stringify(a));
    await until(async () => (await json(await fetch(`${base}/api/approvals`))).approvals.length > 0, '承認待ちになる');
    const r = await fetch(`${base}/api/quit`, { method: 'POST' });
    assert.equal(r.status, 200, `作業中の終了を断った: ${r.status} ${await r.clone().text()}`);
    assert.equal((await json(r)).quitting, true);
    await until(() => stopped !== undefined, '止める側が呼ばれる', { timeoutMs: 5000 });
    await stopped;
    assert.equal(approved, false, '承認待ちが拒否で解かれていない');
    await assert.rejects(fetch(`${base}/api/info`), '本体が止まっていない');
  } finally {
    if (!stopped) await server.stop();
    await fake.close();
  }
});
