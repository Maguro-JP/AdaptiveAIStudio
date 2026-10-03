/**
 * 作業中に提案を採用しても、黙って消さない。
 *
 * 採用の口は先に「採用済み」と決めてから、作業中でなければ走らせていた。作業中に押すと、提案は一覧から消えたまま
 * 何も走らず、二度と出てこなかった。作業中は断り（409）、提案は開いたまま残す。
 * 採否の綴りも確かめる（`accepted` / `rejected` 以外を「採用」と読むと、モデルが書いた文を走らせる側へ倒れる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-proposal-busy-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('作業中の採用は断って提案を残し、終われば採用できる', async () => {
  const fake = await startFakeServer({ kind: 'echo', delayFor: (asked: string) => (asked.includes('長い依頼') ? 2500 : 50) });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  const post = (p: string, body?: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const openIds = async (): Promise<string[]> =>
    ((await (await fetch(`${base}/api/proposals`)).json()) as { open: { id: string }[] }).open.map((p) => p.id);
  try {
    const session = await server.session();
    const p = session.proposals.add({ kind: 'question', title: '説明を足す', rationale: '試し', evidence: [], suggestedAction: '短い依頼', fingerprint: 'busy-1' });
    assert.ok(p);

    const sent = await (await post('/api/send', { text: '長い依頼' })).json() as { accepted?: boolean };
    assert.equal(sent.accepted, true);

    // 綴りの違いは採用と読まない
    assert.equal((await post('/api/proposal', { id: p.id, verdict: 'reject' })).status, 400);
    assert.equal((await post('/api/proposal', { id: p.id })).status, 400);

    const busy = await post('/api/proposal', { id: p.id, verdict: 'accepted' });
    assert.equal(busy.status, 409, `作業中の採用を受けた: ${busy.status}`);
    assert.ok((await openIds()).includes(p.id), '断ったのに提案が消えた');

    // 作業が終われば、採用できて走る
    await until(async () => (await post('/api/proposal', { id: p.id, verdict: 'accepted' })).status === 200,
      '終わってから採用できる', { timeoutMs: 15_000, everyMs: 200 });
    assert.ok(!(await openIds()).includes(p.id));
  } finally {
    await server.stop();
    await fake.close();
  }
});
