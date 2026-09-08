/**
 * Tab 補完の口。
 *
 * エディタで手が止まったら、前後を渡して続きを数行もらう。
 * 読んでいないモデルは読みに行かない。作業中は出さない。上限で諦める。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = await tempDir('aas-complete-');
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  fake = await startFakeServer({ kind: 'stream', text: '```js\n  return a + b;\n}\n```' });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

const post = (body: unknown) => fetch(base + '/api/complete', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('続きをもらう', () => {
  test('前後を渡すと、掃除した続きが返る', async () => {
    const r = await post({ path: 'a.js', prefix: 'function add(a, b) {\n  return ', suffix: '' });
    assert.equal(r.status, 200);
    const j = await r.json() as { text: string; model?: string };
    assert.equal(j.text, 'a + b;\n}');
    assert.equal(j.model, 'local:m');
    // 渡した文に、<CURSOR> と前後が入っている。
    const sent = JSON.stringify(fake.bodies.at(-1));
    assert.ok(sent.includes('<CURSOR>'), '<CURSOR> を挟んでいない');
    assert.ok(sent.includes('return '), '前を渡していない');
  });
  test('path が無ければ 400', async () => {
    assert.equal((await post({ prefix: 'x' })).status, 400);
  });
});

describe('画面', () => {
  test('エディタは、手が止まったら訊き、Tab で入れ、Esc で消す', () => {
    const src = readFileSync(join(here, '../src/ui/web/panels.js'), 'utf8');
    const ed = src.slice(src.indexOf('  editor(body, ctx) {'));
    assert.ok(ed.includes("'/api/complete'"), '口を叩いていない');
    assert.ok(/e\.key === 'Escape'/.test(ed), 'Esc で消していない');
    assert.ok(/acceptGhost\(\)/.test(ed) && /e\.key === 'Tab'/.test(ed), 'Tab で入れていない');
    assert.ok(/setTimeout\([\s\S]{0,60}askCompletion/.test(ed), '手が止まるのを待っていない');
  });
});
