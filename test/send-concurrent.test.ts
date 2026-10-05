/**
 * 別々の会話へ同時に送っても、どれも落とさず、それぞれの会話にだけ載る。
 *
 * 本体の手を真偽値で塞いでいたころは、ある道の後始末が別の道の「塞いでいる」まで倒し、会話を決める間（await）に
 * 来た送りが空いた本体を素通りしていた。二つが同じ本体を取り合い、負けた側は「いま別の作業をしています」で消え、
 * 勝った側も別の会話の履歴で走ることがあった（DECISIONS 10-05）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { until } from './until.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-send-concurrent-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let server: InstanceType<typeof UiServer>;
let base = '';

before(async () => {
  fake = await startFakeServer({ kind: 'stream', text: 'はい' });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

type Message = { role: string; content: string };

async function messages(id: string): Promise<Message[]> {
  const r = await fetch(`${base}/api/conversations/messages?id=${id}`);
  return ((await r.json()) as { messages?: Message[] }).messages ?? [];
}

async function post(text: string, conversationId: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, conversationId }),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

/** 出来事の流れから、警告と失敗の行だけを溜める。 */
function watchLogs(): { logs: string[]; stop: () => void; opened: Promise<void> } {
  const logs: string[] = [];
  const ac = new AbortController();
  const opened = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const e = JSON.parse(line.slice(6)) as { type?: string; level?: string; text?: string };
                if (e.type === 'log' && (e.level === 'error' || e.level === 'warn')) logs.push(e.text ?? '');
              } catch { /* 注釈 */ }
            }
          }
        }
      } catch { /* 止めた */ }
    })();
  })();
  return { logs, stop: () => ac.abort(), opened };
}

describe('別々の会話へ同時に送る', { timeout: 120_000 }, () => {
  test('どれも受け取られ、落とされず、それぞれの会話にだけ載る', async () => {
    const N = 8;
    // 会話を先に作る（一つずつ送って、終わるのを待つ）。
    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const r = await post(`はじめ-${i}`, null);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const id = r.body.conversationId as string;
      ids.push(id);
      await until(async () => (await messages(id)).some((m) => m.role === 'assistant'), `会話 ${i} の一回目が終わらない`);
    }
    assert.equal(new Set(ids).size, N, '会話が分かれていない');

    const watch = watchLogs();
    await watch.opened;
    try {
      // 本体が空いているところへ、別々の会話への送りを一度に投げる。
      const results = await Promise.all(ids.map((id, i) => post(`同時-${i}`, id)));
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, 202, `送り ${i} が受け取られていない: ${JSON.stringify(r.body)}`);
        assert.ok(r.body.accepted === true || typeof r.body.queued === 'number', `送り ${i} の返りの形: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.conversationId, ids[i], `送り ${i} が別の会話へ入った`);
      }
      // どの会話にも、自分への依頼と答えが載るまで待つ。
      await until(async () => {
        for (const [i, id] of ids.entries()) {
          const ms = await messages(id);
          const asked = ms.findIndex((m) => m.role === 'user' && m.content.includes(`同時-${i}`));
          if (asked < 0 || !ms.slice(asked + 1).some((m) => m.role === 'assistant')) return false;
        }
        return true;
      }, '同時に送った依頼の答えが、どこかの会話に載らない');
      await assertOwnOnly(ids, '同時');
      assert.deepEqual(watch.logs.filter((t) => t.includes('いま別の作業をしています')), [], '同時の送りが本体を取り合って落ちた');
    } finally { watch.stop(); }
    sharedIds = ids;
  });

  test('立ち上げた直後（本体がまだ無い）に同時に送っても、取り合わない', async () => {
    assert.equal(sharedIds.length > 0, true, '前の試験で会話ができていない');
    const ids = sharedIds;
    // 同じ記録の場所を見る別の本体。まだ一度も送っていないので、本体のセッションが無い。
    const again = new UiServer({ port: 0, config: server.config });
    const prevBase = base;
    base = (await again.start()).replace(/\/$/, '');
    const watch = watchLogs();
    await watch.opened;
    try {
      const results = await Promise.all(ids.map((id, i) => post(`直後-${i}`, id)));
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, 202, `送り ${i} が受け取られていない: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.conversationId, ids[i], `送り ${i} が別の会話へ入った`);
      }
      await until(async () => {
        for (const [i, id] of ids.entries()) {
          const ms = await messages(id);
          const asked = ms.findIndex((m) => m.role === 'user' && m.content.includes(`直後-${i}`));
          if (asked < 0 || !ms.slice(asked + 1).some((m) => m.role === 'assistant')) return false;
        }
        return true;
      }, '立ち上げ直後に同時に送った依頼の答えが、どこかの会話に載らない');
      await assertOwnOnly(ids, '直後');
      assert.deepEqual(watch.logs.filter((t) => t.includes('いま別の作業をしています')), [], '本体が無いところで同時の送りが取り合って落ちた');
    } finally { watch.stop(); await again.stop(); base = prevBase; }
  });
});

let sharedIds: string[] = [];

/** どの会話にも、自分の番号の依頼だけが載っている（ほかの番号の依頼が一つも無い）。 */
async function assertOwnOnly(ids: string[], label: string): Promise<void> {
  const marks = ['はじめ', '同時', '直後'];
  for (const [i, id] of ids.entries()) {
    const users = (await messages(id)).filter((m) => m.role === 'user').map((m) => m.content);
    const foreign = users.filter((c) => ids.some((_, j) => j !== i && marks.some((k) => c.includes(`${k}-${j}`))));
    assert.deepEqual(foreign, [], `会話 ${i} に別の会話の依頼が混ざった（${label}）`);
  }
}
