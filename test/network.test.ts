import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchUrlTool, checkHost, toText, HostNotAllowed, DEFAULT_ALLOWED_HOSTS,
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

/**
 * 外への出口の配り方。
 *
 * 以前は「外へ出られるのは情報担当ただ一人」にしていた。
 * これは**やめた**。出口を一つに絞ると、外の情報が要る役が増えるたびに
 * 情報担当を経由させることになり、agent を一段挟むぶん遅く、
 * 途中で情報も落ちる。**制限のために性能を落とすなら、その制限に意味は無い。**
 *
 * 守るべきものは「出口の数」ではなく、**外から来たものが
 * そのまま書き込みに化けないこと**だった。そこだけを条件にする。
 */
describe('権限の配り方', () => {
  test('外から取ってきて、そのまま書ける役職を作らない', async () => {
    const { BUILTIN_ROLES } = await import('../src/roles/builtin.ts');
    // 外の内容には、こちらを操ろうとするものが混ざり得る。
    // 読んだ役がそのまま書けると、それが直接ファイルに届く。
    // 外へ出る道は network だけではない。外の道具（mcp）も同じ扱いにする。
    const both = BUILTIN_ROLES
      .filter((r) => (r.access.includes('network') || r.access.includes('mcp'))
        && r.access.includes('write'))
      .map((r) => r.id);
    assert.deepEqual(both, [], `外に出て書ける役職がいる: ${both.join(', ')}`);
  });

  test('外へ出る役職は、出ると分かる形で持つ', async () => {
    const { BUILTIN_ROLES } = await import('../src/roles/builtin.ts');
    const outward = BUILTIN_ROLES.filter((r) => r.access.includes('network')).map((r) => r.id);
    // 一人に絞る必要は無い。ただし誰が出るかは、役職表を見れば分かること。
    assert.ok(outward.length >= 1, '外へ出られる役職がいない');
    assert.ok(outward.includes('envoy'), '情報担当が外へ出られない');
  });

  test('network を持たない役職には fetch_url が渡らない', async () => {
    const { toolsFor } = await import('../src/roles/registry.ts');
    const { BUILTIN_ROLES } = await import('../src/roles/builtin.ts');
    const net = createFetchUrlTool({});
    const pool = { read: [], write: [], execute: [], network: [net] };
    for (const role of BUILTIN_ROLES) {
      const names = toolsFor(role, pool).map((t) => t.schema.name);
      assert.equal(names.includes('fetch_url'), role.access.includes('network'), `${role.id}`);
    }
  });
});

describe('読み方', () => {
  test('上限の先は読まない（何百MBでも抱えない）', async () => {
    let pulls = 0;
    let canceled = false;
    const enc = new TextEncoder();
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(enc.encode('a'.repeat(1024))); },
      cancel() { canceled = true; },
    });
    const tool = createFetchUrlTool({
      maxBytes: 100,
      fetchImpl: (async () => new Response(endless, { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx());
    assert.ok(r.content.includes('省略'));
    assert.ok(pulls < 20, `読みすぎている: ${pulls} 回`);
    assert.equal(canceled, true, '残りを切っていない');
  });

  test('Shift_JIS の頁は、言われた通りに読む', async () => {
    const sjis = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]); // あいう
    const tool = createFetchUrlTool({
      fetchImpl: (async () => new Response(sjis, { status: 200, headers: { 'content-type': 'text/plain; charset=Shift_JIS' } })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx());
    assert.ok(r.content.includes('あいう'), r.content);
    assert.ok(!r.content.includes('\ufffd'));
  });

  test('charset が無い UTF-8 は、そのまま（対）', async () => {
    const tool = createFetchUrlTool({
      fetchImpl: (async () => new Response('あいう', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
    });
    const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx());
    assert.ok(r.content.includes('あいう'));
  });
});
