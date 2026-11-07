/**
 * 天気（Open-Meteo）を取る段と、試さずに「分かりません」で終えない押し戻し。
 * 本物のネットワークには出ない（偽の Open-Meteo を fetch の代わりに渡す）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import {
  DefaultSource, WeatherSource, dayOffsetOf, gather, isWeatherQuestion, placeOf, SOURCE_ALLOWED_HOSTS,
} from '../src/core/knowledge-source.ts';
import { KnowledgeShelf } from '../src/core/knowledge.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { NetworkProvider } from '../src/core/network-provider.ts';
import type { ChatProvider, ProviderChunk } from '../src/providers/contract.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type { ProviderMessage as Message } from '../src/providers/contract.ts';
import { givesUp, giveUpNudge } from '../src/agent/work-style.ts';

/** 偽の Open-Meteo。受けた URL と依頼の形を覚える。 */
function fakeOpenMeteo() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const u = new URL(url);
    if (u.host === 'geocoding-api.open-meteo.com') {
      const name = u.searchParams.get('name');
      if (name === 'ナイマチ' || name === '大阪') return Response.json({ results: [] });
      return Response.json({ results: [{ name, latitude: 35.69, longitude: 139.69 }] });
    }
    if (u.host === 'api.open-meteo.com') {
      return Response.json({ daily: {
        time: ['2026-11-07', '2026-11-08', '2026-11-09'],
        weather_code: [0, 61, 3],
        temperature_2m_max: [20.1, 17.4, 18.0],
        temperature_2m_min: [11.0, 12.3, 10.2],
        precipitation_probability_max: [0, 80, 20],
      } });
    }
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return { calls, impl };
}

describe('天気の問いを読む', () => {
  test('天気・気温・雨・降水を天気と読む', () => {
    for (const q of ['明日の天気は?', '明日の気温', '明日雨降る?', '降水確率は']) assert.equal(isWeatherQuestion(q), true, q);
    assert.equal(isWeatherQuestion('zod の最新の版'), false);
  });
  test('場所を拾う。日の言い方は場所にしない', () => {
    assert.equal(placeOf('大阪の明日の天気は?'), '大阪');
    assert.equal(placeOf('明日の東京の天気は?'), '東京');
    assert.equal(placeOf('明日の天気は?'), undefined);
  });
  test('日を読む', () => {
    assert.equal(dayOffsetOf('今日の天気'), 0);
    assert.equal(dayOffsetOf('明日の天気'), 1);
    assert.equal(dayOffsetOf('明後日の天気'), 2);
  });
  test('行き先は許可リストに入っている', () => {
    assert.ok(SOURCE_ALLOWED_HOSTS.includes('api.open-meteo.com'));
    assert.ok(SOURCE_ALLOWED_HOSTS.includes('geocoding-api.open-meteo.com'));
  });
});

describe('Open-Meteo から取る', () => {
  test('明日の予報を、日本時間・GET・資格情報なしで取る', async () => {
    const om = fakeOpenMeteo();
    const got = await new WeatherSource({ fetchImpl: om.impl }).fetch('大阪の明日の天気は?', new AbortController().signal);
    assert.match(got!.answer, /大阪市の2026-11-08.*雨.*最高 17.4℃・最低 12.3℃.*降水確率 80%/);
    assert.equal(got!.ephemeral, true);
    assert.equal(om.calls.length, 3, '大阪 → 大阪市 → 予報');
    assert.match(om.calls[2]!.url, /timezone=Asia%2FTokyo/);
    for (const c of om.calls) { assert.equal(c.init?.method, 'GET'); assert.equal(c.init?.credentials, 'omit'); }
  });
  test('場所が無ければ既定の場所を使う', async () => {
    const om = fakeOpenMeteo();
    const got = await new WeatherSource({ fetchImpl: om.impl, location: () => '札幌' }).fetch('明日の天気は?', new AbortController().signal);
    assert.match(om.calls[0]!.url, new RegExp(`name=${encodeURIComponent('札幌')}`));
    assert.match(got!.answer, /札幌/);
  });
  test('場所が見つからなければ理由を言う（作らない）', async () => {
    const om = fakeOpenMeteo();
    const shelf = new KnowledgeShelf(join(await tempDir('wx-'), 'k'));
    const r = await gather('ナイマチの天気', new WeatherSource({ fetchImpl: om.impl }), shelf, new AbortController().signal);
    assert.equal(r.status, 'failed');
    assert.match((r as { reason: string }).reason, /見つかりませんでした/);
  });
  test('天気は蔵に残さない', async () => {
    const om = fakeOpenMeteo();
    const shelf = new KnowledgeShelf(join(await tempDir('wx-'), 'k'));
    const r = await gather('明日の天気は?', new DefaultSource({ fetchImpl: om.impl }), shelf, new AbortController().signal);
    assert.equal(r.status, 'stored');
    assert.equal(await shelf.isEmpty(), true);
  });
  test('天気の問いを npm へ回さない', async () => {
    const om = fakeOpenMeteo();
    await new DefaultSource({ fetchImpl: om.impl }).fetch('明日の天気', new AbortController().signal);
    assert.ok(om.calls.every((c) => !c.url.includes('registry.npmjs.org')));
  });
});

describe('ネットワークの送り口で天気を足す', () => {
  test('挙げる段が [] でも、利用者の一言が天気なら取りに行き、system に載せる', async () => {
    const systems: string[] = [];
    const inner: ChatProvider = {
      id: 'fake', locality: 'local',
      async health() { return { ok: true }; },
      async listModels() { return [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }]; },
      async *chat(req): AsyncIterable<ProviderChunk> {
        systems.push(String(req.system ?? ''));
        yield { type: 'text', delta: '明日は雨です' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const om = fakeOpenMeteo();
    const registry = new ProviderRegistry();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m'], {
      shelf: new KnowledgeShelf(join(await tempDir('wx-'), 'k')),
      lister: { list: async () => [] },
      source: new DefaultSource({ fetchImpl: om.impl }),
    }));
    const evs: ChatEvent[] = [];
    for await (const ev of new ChatOrchestrator(registry).run({
      candidates: ['network:network'], messages: [{ role: 'user', content: '明日の天気は?' }],
    }, new AbortController().signal)) evs.push(ev);
    assert.ok(systems.some((s) => /東京の2026-11-08.*雨/.test(s)), `天気が載っていない: ${systems.join('|')}`);
  });
});

describe('試さずに分からないと言って終えない', () => {
  test('言い回しを読む', () => {
    assert.equal(givesUp('わかりません'), true);
    assert.equal(givesUp('明日の天気は分かりません。'), true);
    assert.equal(givesUp("I don't know."), true);
    assert.equal(givesUp('天気を取りに行きましたが、繋がりませんでした。足りないのはネットワークです。分かりません。'), false);
    assert.equal(givesUp('明日は晴れ、最高 18℃ です。'), false);
  });

  function scripted(turns: ChatEvent[][]): ChatOrchestrator {
    let n = 0;
    return { async *run() { const evs = turns[Math.min(n, turns.length - 1)]!; n += 1; for (const ev of evs) yield ev; } } as unknown as ChatOrchestrator;
  }
  const done: ChatEvent = { type: 'done', modelId: 'm' };
  const say = (t: string): ChatEvent => ({ type: 'text', delta: t });

  async function run(turns: ChatEvent[][], withTools: boolean, history: Message[]) {
    const tools = withTools ? [{
      schema: { name: 'fetch_url', description: 'x', parameters: { type: 'object', properties: {} } } as never,
      run: async () => ({ content: 'ok' }),
    }] : [];
    const agent = new Agent(scripted(turns), {
      candidates: ['m'], system: 'test', tools, root: await tempDir('aas-giveup-'), maxTurns: 6, approve: async () => true,
    });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run(history, new AbortController().signal)) events.push(ev);
    return events;
  }

  test('ツールを使わずに「わかりません」なら一度押し戻し、ツールを使えと言う', async () => {
    const history: Message[] = [{ role: 'user', content: '明日の天気は?' }];
    const events = await run([[say('わかりません'), done], [say('わかりません'), done], [say('わかりません'), done]], true, history);
    assert.equal(events.filter((e) => e.type === 'nudged').length, 1, '一度だけ押し戻す');
    assert.ok(history.some((m) => m.role === 'user' && m.content === giveUpNudge(true)));
  });
  test('ツールが無い問いでは、何が足りないかを書かせる', async () => {
    const history: Message[] = [{ role: 'user', content: '明日の天気は?' }];
    await run([[say('分かりません'), done], [say('明日は雨、最高 17℃ です。'), done]], false, history);
    assert.ok(history.some((m) => m.role === 'user' && m.content === giveUpNudge(false)));
  });
  test('答えていれば押し戻さない（対）', async () => {
    const events = await run([[say('明日は雨、最高 17℃ です。'), done]], true, [{ role: 'user', content: '明日の天気は?' }]);
    assert.equal(events.some((e) => e.type === 'nudged'), false);
  });
});

describe('Node.js の版', () => {
  test('配布の一覧から LTS を取り、蔵に残さない', async () => {
    const { NodeReleaseSource, isNodeReleaseQuestion } = await import('../src/core/knowledge-source.ts');
    assert.equal(isNodeReleaseQuestion('Node.js の最新の LTS は?'), true);
    assert.equal(isNodeReleaseQuestion('node:util の diff の使い方'), false);
    const impl = (async () => Response.json([
      { version: 'v25.1.0', date: '2026-10-28', lts: false },
      { version: 'v24.11.0', date: '2026-10-20', lts: 'Krypton' },
    ])) as unknown as typeof fetch;
    const got = await new NodeReleaseSource({ fetchImpl: impl }).fetch('Node.js の最新の LTS は?', new AbortController().signal);
    assert.match(got!.answer, /LTS は v24\.11\.0/);
    assert.equal(got!.ephemeral, true);
  });
});

describe('問いの中の式は、この機械で計算する', () => {
  test('1234 × 5678 は 7006652（4B は 7001052 と答えた）', async () => {
    const { arithmeticIn, arithmeticBlock } = await import('../src/core/arithmetic.ts');
    assert.deepEqual(arithmeticIn('1234 × 5678 は?'), [{ expr: '1234 × 5678', value: '7006652' }]);
    assert.equal(arithmeticIn('(2+3)*4 と 10 ÷ 4')[0]!.value, '20');
    assert.equal(arithmeticIn('10 ÷ 4')[0]!.value, '2.5');
    assert.equal(arithmeticIn('2026-11-08 の天気').length, 0, '日付は式と読まない');
    assert.equal(arithmeticIn('10 - 3')[0]!.value, '7');
    assert.equal(arithmeticBlock('こんにちは'), '');
    assert.equal(arithmeticIn('1 / 0').length, 0);
  });
  test('ネットワークの送り口が、計算した値を system に載せる', async () => {
    const systems: string[] = [];
    const inner: ChatProvider = {
      id: 'fake', locality: 'local',
      async health() { return { ok: true }; },
      async listModels() { return [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }]; },
      async *chat(req): AsyncIterable<ProviderChunk> { systems.push(String(req.system ?? '')); yield { type: 'done', finishReason: 'stop' }; },
    };
    const registry = new ProviderRegistry();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m'], { lister: { list: async () => [] } }));
    for await (const _ of new ChatOrchestrator(registry).run({ candidates: ['network:network'], messages: [{ role: 'user', content: '1234 × 5678 は?' }] }, new AbortController().signal)) { /* */ }
    assert.ok(systems.some((s) => s.includes('1234 × 5678 = 7006652')), systems.join('|'));
  });
});
