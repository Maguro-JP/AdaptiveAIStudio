/**
 * `/plan` で添えたファイルを、黙って捨てない。
 *
 * 画面は依頼の下に「📎 名前」を出して預かりを空にするのに、`/api/plan` は依頼の文しか読まず、段取りは添付を見ないまま組まれていた。
 * 利用者はファイルを見たうえでの段取りだと思って進める。送り口（`/api/send`）と同じく、添付の中身を依頼に差し込む。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-plan-attach-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('/plan に添えたファイルの中身が、段取りを組むモデルに届く', async () => {
  const root = await tempDir('aas-plan-attach-root-');
  const fake = await startFakeServer({ kind: 'stream', text: '段取りは組めませんでした。' });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, approval: 'auto', root },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  try {
    const put = await fetch(`${base}/api/attach?name=spec.txt`, { method: 'POST', body: '添付だけに書いた文字列: KIWI-4412\n' });
    const putText = await put.text();
    assert.equal(put.status, 200, putText);
    const { id } = JSON.parse(putText) as { id: string };
    const planned = await fetch(`${base}/api/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '添付の仕様どおりに直して', attachments: [id] }),
    });
    assert.equal(planned.status, 202, await planned.text());
    // 見たいことそのものを待つ（問いの数だけを待つと、本文を読み終える前に見て落ちうる）
    await until(() => /KIWI-4412/.test(JSON.stringify(fake.bodies)), '添付の中身がモデルに届く', { timeoutMs: 30_000 });
    const sent = JSON.stringify(fake.bodies);
    assert.match(sent, /添付の仕様どおりに直して/, '利用者が打った文が依頼から消えた');
  } finally { await server.stop(); await fake.close(); }
});
