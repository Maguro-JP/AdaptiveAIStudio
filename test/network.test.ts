import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFetchUrlTool, checkHost, toText, HostNotAllowed, DEFAULT_ALLOWED_HOSTS,
} from '../src/agent/tools/network.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

function ctx(approve = true): ToolContext & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    root: process.cwd(),
    signal: new AbortController().signal,
    asked,
    async approve(req) { asked.push(req); return approve; },
  };
}

describe('行き先の照合', () => {
  const allowed = new Set(['registry.npmjs.org']);

  test('許可された行き先は通る', () => {
    assert.equal(checkHost('https://registry.npmjs.org/react', allowed).hostname, 'registry.npmjs.org');
  });

  test('許可されていない行き先は弾く', () => {
    assert.throws(() => checkHost('https://evil.example/x', allowed), HostNotAllowed);
  });

  test('サブドメインは明示されない限り許さない', () => {
    assert.throws(() => checkHost('https://a.registry.npmjs.org/x', allowed), HostNotAllowed);
  });

  test('https 以外は許さない', () => {
    assert.throws(() => checkHost('http://registry.npmjs.org/x', allowed), HostNotAllowed);
    assert.throws(() => checkHost('file:///etc/passwd', allowed), HostNotAllowed);
  });

  test('既定の行き先に検索エンジンやニュースは入れない', () => {
    for (const h of DEFAULT_ALLOWED_HOSTS) {
      assert.ok(!/google|bing|news|twitter|reddit/.test(h), `雑音の出所が混じっている: ${h}`);
    }
  });
});

describe('本文の取り出し', () => {
  test('HTML はタグを落とす', () => {
    const out = toText('<html><body><script>bad()</script><p>ここが本文</p></body></html>', 'text/html');
    assert.equal(out.includes('bad()'), false);
    assert.ok(out.includes('ここが本文'));
  });

  test('JSON はそのまま', () => {
    const json = '{"latest":"1.2.3"}';
    assert.equal(toText(json, 'application/json'), json);
  });
});

describe('fetch_url', () => {
  const good = async () => new Response('{"latest":"1.2.3"}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  test('出典を必ず添えて返す', async () => {
    const tool = createFetchUrlTool({ fetchImpl: good as unknown as typeof fetch });
    const r = await tool.run({ url: 'https://registry.npmjs.org/react' }, ctx());
    assert.ok(r.content.includes('出典: https://registry.npmjs.org/react'));
    assert.ok(r.content.includes('1.2.3'));
  });

  test('外へ出る前に承認を求める', async () => {
    const tool = createFetchUrlTool({ fetchImpl: good as unknown as typeof fetch });
    const c = ctx();
    await tool.run({ url: 'https://registry.npmjs.org/react' }, c);
    assert.deepEqual(c.asked, [{ kind: 'network', url: 'https://registry.npmjs.org/react' }]);
  });

  test('承認されなければ取りに行かない', async () => {
    let called = false;
    const tool = createFetchUrlTool({
      fetchImpl: (async () => { called = true; return good(); }) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/react' }, ctx(false));
    assert.equal(called, false);
    assert.equal(r.isError, true);
  });

  test('外が落ちていても例外を投げず、手元で進めと返す', async () => {
    const tool = createFetchUrlTool({
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/react' }, ctx());
    assert.equal(r.isError, true);
    assert.ok(r.content.includes('手元で確認できる範囲で進めて'));
  });

  test('応答しない相手で止まらない', async () => {
    const tool = createFetchUrlTool({
      timeoutMs: 30,
      fetchImpl: ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/react' }, ctx());
    assert.equal(r.isError, true);
    assert.ok(r.content.includes('30ms'));
  });

  test('404 も情報として返す（握り潰さない）', async () => {
    const tool = createFetchUrlTool({
      fetchImpl: (async () => new Response('not found', {
        status: 404, headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/nope' }, ctx());
    assert.ok(r.content.includes('404'));
  });

  test('長すぎる応答は切る', async () => {
    const tool = createFetchUrlTool({
      maxBytes: 50,
      fetchImpl: (async () => new Response('あ'.repeat(500), {
        status: 200, headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx());
    assert.ok(r.content.includes('省略'));
    assert.ok(r.content.length < 300);
  });

  test('許可外は取りに行く前に弾く', async () => {
    let called = false;
    const tool = createFetchUrlTool({
      fetchImpl: (async () => { called = true; return good(); }) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://evil.example/steal' }, ctx());
    assert.equal(called, false);
    assert.equal(r.isError, true);
  });

  test('横取りされないよう転送を追わない', async () => {
    let init: RequestInit | undefined;
    const tool = createFetchUrlTool({
      fetchImpl: ((_u: string, i: RequestInit) => { init = i; return good(); }) as unknown as typeof fetch,
    });
    await tool.run({ url: 'https://registry.npmjs.org/react' }, ctx());
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
  });
});

describe('権限の配り方', () => {
  test('外へ出られるのは情報担当だけ', async () => {
    const { BUILTIN_ROLES } = await import('../src/roles/builtin.ts');
    const outward = BUILTIN_ROLES.filter((r) => r.access.includes('network')).map((r) => r.id);
    assert.deepEqual(outward, ['envoy']);
  });

  test('network を持たない役職には fetch_url が渡らない', async () => {
    const { toolsFor } = await import('../src/roles/registry.ts');
    const { BUILTIN_ROLES } = await import('../src/roles/builtin.ts');
    const net = createFetchUrlTool({});
    const pool = { read: [], write: [], execute: [], network: [net] };
    for (const role of BUILTIN_ROLES) {
      const names = toolsFor(role, pool).map((t) => t.schema.name);
      assert.equal(names.includes('fetch_url'), role.id === 'envoy', `${role.id}`);
    }
  });
});
