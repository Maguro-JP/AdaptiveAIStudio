/**
 * 知識の蔵と「知らないことを挙げる」段（docs/NETWORK-MODEL.md の段階 2）。中のモデルは偽物。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { NetworkProvider, NETWORK_MODEL_ID, parseNeeds, type NeedLister } from '../src/core/network-provider.ts';
import { KnowledgeShelf, knowledgeBlock } from '../src/core/knowledge.ts';
import type { ChatProvider, ProviderChunk, ProviderRequest } from '../src/providers/contract.ts';
import { tempDir } from './tmp.ts';

const FACT = { question: 'zod の最新の版', answer: 'zod の最新は 9.9.9', sourceUrl: 'https://example.com/zod', fetchedAt: '2026-11-01T00:00:00Z', version: '9.9.9' };

/** 受けた依頼を覚え、system に「最新は x」があればそれを答えに写す偽のモデル。 */
function echoInner(): ChatProvider & { asked: ProviderRequest[] } {
  const asked: ProviderRequest[] = [];
  return {
    id: 'fake', locality: 'local', asked,
    async health() { return { ok: true }; },
    async listModels() { return [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }]; },
    async *chat(req): AsyncIterable<ProviderChunk> {
      asked.push(req);
      const m = /最新は ([\d.]+)/.exec(req.system ?? '');
      yield { type: 'text', delta: m ? `版は ${m[1]} です` : '知りません' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

const lister = (fn: () => Promise<string[]>): NeedLister & { calls: number } => {
  const l = { calls: 0, async list() { l.calls++; return fn(); } };
  return l;
};

async function ask(shelf: KnowledgeShelf, l: NeedLister, system?: string) {
  const registry = new ProviderRegistry();
  const inner = echoInner();
  registry.register(inner);
  registry.register(new NetworkProvider(registry, () => ['fake:m'], { shelf, lister: l }));
  const events: ChatEvent[] = [];
  for await (const ev of new ChatOrchestrator(registry).run({
    candidates: [NETWORK_MODEL_ID, 'fake:m'], ...(system ? { system } : {}),
    messages: [{ role: 'user', content: 'zod を入れて' }],
  }, new AbortController().signal)) events.push(ev);
  return { inner, text: events.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

describe('知識の蔵を使う', () => {
  test('蔵に入れた事実が中のモデルへの依頼に出どころつきで入り、それを使った答えが返る', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-a-'));
    await shelf.upsert(FACT);
    const { inner, text } = await ask(shelf, lister(async () => ['zod の最新の版']), '元の system');
    assert.equal(text, '版は 9.9.9 です');
    assert.equal(inner.asked.length, 1);
    assert.match(inner.asked[0]!.system ?? '', /^元の system\n\n/);
    assert.match(inner.asked[0]!.system ?? '', /https:\/\/example\.com\/zod/);
  });

  test('蔵が空なら、挙げる段を呼ばず、依頼は段階 1 と同じ', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-b-'));
    const l = lister(async () => ['zod の最新の版']);
    const { inner, text } = await ask(shelf, l, '元の system');
    assert.equal(l.calls, 0);
    assert.equal(inner.asked[0]!.system, '元の system');
    assert.equal(text, '知りません');
  });

  test('当たらない問いなら何も足さない', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-c-'));
    await shelf.upsert(FACT);
    const { inner } = await ask(shelf, lister(async () => ['python の venv']));
    assert.equal(inner.asked[0]!.system, undefined);
  });

  test('挙げる段が落ちても、答えは返る', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-d-'));
    await shelf.upsert(FACT);
    const { text } = await ask(shelf, lister(async () => { throw new Error('落ちた'); }));
    assert.equal(text, '知りません');
  });

  test('挙げる段が形の違うものを返しても、答えは返る', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-e-'));
    await shelf.upsert(FACT);
    const { text } = await ask(shelf, lister(async () => ({ not: 'json' }) as unknown as string[]));
    assert.equal(text, '知りません');
  });

  test('既定の挙げる段: 中のモデルが JSON でない返事をしても、本番の依頼は通る', async () => {
    const shelf = new KnowledgeShelf(await tempDir('aas-kn-f-'));
    await shelf.upsert(FACT);
    const registry = new ProviderRegistry();
    const inner = echoInner();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m'], { shelf }));
    let text = '';
    for await (const ev of new ChatOrchestrator(registry).run({
      candidates: [NETWORK_MODEL_ID, 'fake:m'], messages: [{ role: 'user', content: 'x' }],
    }, new AbortController().signal)) if (ev.type === 'text') text += ev.delta;
    assert.equal(text, '知りません');
    assert.equal(inner.asked.length, 2);
    assert.equal(inner.asked[0]!.temperature, 0);
    assert.equal(inner.asked[0]!.tools, undefined);
  });

  test('問いの並びを取り出す: JSON の配列だけ、最大 5 個', () => {
    assert.deepEqual(parseNeeds('ここ: ["a", 1, "b"]'), ['a', 'b']);
    assert.deepEqual(parseNeeds('分かりません'), []);
    assert.deepEqual(parseNeeds('[壊れた'), []);
    assert.equal(parseNeeds(JSON.stringify(['1', '2', '3', '4', '5', '6', '7'])).length, 5);
  });
});

describe('知識の蔵', () => {
  test('書いたものを別の蔵から読め、効いた・外れたを数え、同じ問いは上書きで回数を残す', async () => {
    const dir = await tempDir('aas-kn-g-');
    const a = new KnowledgeShelf(dir);
    await a.upsert(FACT);
    assert.equal(await a.mark('ZOD の最新の版', 'hit'), true);
    await a.mark('zod の最新の版', 'hit');
    await a.mark('zod の最新の版', 'miss');
    assert.equal(await a.mark('無い問い', 'hit'), false);
    await a.upsert({ ...FACT, answer: 'zod の最新は 10.0.0' });
    const b = new KnowledgeShelf(dir);
    const all = await b.all();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.answer, 'zod の最新は 10.0.0');
    assert.equal(all[0]!.hits, 2);
    assert.equal(all[0]!.misses, 1);
    assert.ok(JSON.parse(await readFile(join(dir, 'shelf.json'), 'utf8')));
    assert.equal((await b.find('zod 最新の版'))?.question, FACT.question);
    assert.equal(await b.find('react の版'), undefined);
  });

  test('詰める量は上限を超えない', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...FACT, question: `問い${i}`, answer: 'あ'.repeat(100), hits: 0, misses: 0 }));
    const block = knowledgeBlock(many, 600);
    assert.ok(block.length <= 600 && block.length > 0);
    assert.equal(knowledgeBlock([]), '');
  });
});
