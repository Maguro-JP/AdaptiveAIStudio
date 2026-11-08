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
      // 日付や曜日の切れ端（「日」「月曜日」）は、本物と同じく引けない
      if (/^(?:日|月曜日?)(?:市|都|府|県)?$/.test(name ?? '')) return Response.json({ results: [] });
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

/**
 * Windows の work（run 42442577525）: 同じアプリで「明日の東京の天気は?」のあとの「明日の天気は?」に、
 * 挙げる段が「2026年11月9日の天気」と言い換え、「日」を場所と読んで取れず、既定の場所の天気が載らなかった。
 */
describe('場所の無い天気の問いに既定の場所を使う（挙げる段が日付で言い換えても）', () => {
  async function converse(asks: string[], location: { value: string }) {
    const systems: string[] = [];
    const inner: ChatProvider = {
      id: 'fake', locality: 'local',
      async health() { return { ok: true }; },
      async listModels() { return [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }]; },
      async *chat(req): AsyncIterable<ProviderChunk> {
        systems.push(String(req.system ?? ''));
        yield { type: 'text', delta: '答え' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const om = fakeOpenMeteo();
    const registry = new ProviderRegistry();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m'], {
      shelf: new KnowledgeShelf(join(await tempDir('wx-'), 'k')),
      // 小さいモデルの挙げ方を真似る（日付で言い換える）
      lister: { list: async () => ['2026年11月9日の天気', '月曜日の天気'] },
      source: new DefaultSource({ fetchImpl: om.impl, location: () => location.value }),
    }));
    const messages: Message[] = [];
    const perAsk: string[][] = [];
    for (const ask of asks) {
      messages.push({ role: 'user', content: ask });
      const before = systems.length;
      const callsBefore = om.calls.length;
      for await (const ev of new ChatOrchestrator(registry).run({ candidates: ['network:network'], messages: [...messages] } as never, new AbortController().signal)) void ev;
      messages.push({ role: 'assistant', content: '答え' });
      perAsk.push([systems.slice(before).join('|'), om.calls.slice(callsBefore).map((c) => new URL(c.url).searchParams.get('name') ?? '').filter(Boolean).join(',')]);
    }
    return perAsk;
  }

  test('placeOf は日付・曜日を場所にしない', () => {
    assert.equal(placeOf('2026年11月9日の天気'), undefined);
    assert.equal(placeOf('11月9日の天気予報'), undefined);
    assert.equal(placeOf('月曜日の天気'), undefined);
    assert.equal(placeOf('明日の東京の天気は?'), '東京');
    assert.equal(placeOf('日本の天気'), '日本');
  });

  test('場所つきの問いのあとの、場所の無い問いに既定の東京を使う', async () => {
    const [first, second] = await converse(['明日の東京の天気は?', '明日の天気は?'], { value: '東京' });
    assert.match(first![0]!, /東京の2026-11-08.*雨/);
    assert.match(second![0]!, /東京の2026-11-08.*雨/, `二つ目に天気が載っていない: ${second![0]}`);
    assert.doesNotMatch(second![1]!, /(^|,)日(,|$)/, `「日」を場所として引いた: ${second![1]}`);
  });

  test('最初の問いが場所の無い問いでも既定の場所を使う', async () => {
    const [only] = await converse(['明日の天気は?'], { value: '東京' });
    assert.match(only![0]!, /東京の2026-11-08.*雨/, `天気が載っていない: ${only![0]}`);
  });

  test('設定の場所を変えたら、次の問いから変えた場所を使う', async () => {
    const loc = { value: '東京' };
    const om: string[][] = [];
    const run = await converse(['明日の天気は?'], loc);
    om.push(...run);
    loc.value = '札幌';
    const [after] = await converse(['明日の天気は?'], loc);
    assert.match(om[0]![0]!, /東京の/);
    assert.match(after![0]!, /札幌の2026-11-08.*雨/, `変えた場所が使われていない: ${after![0]}`);
  });
});

describe('試さずに分からないと言って終えない', () => {
  test('言い回しを読む', () => {
    assert.equal(givesUp('わかりません'), true);
    assert.equal(givesUp('明日の天気は分かりません。'), true);
    assert.equal(givesUp("I don't know."), true);
    // Windows の work で押し戻されなかった言い回し
    assert.equal(givesUp('2026 年 11 月 9 日（月）の天気は、知識の蔵から確認できません。天気予報は、以下の情報が必要ですが、現在入手できていません。- 場所（都市名など）- 予報データ もし、場所や予報データがあれば、すぐに調べることができます。'), true);
    assert.equal(givesUp('明日の天気は入手できていません。'), true);
    assert.equal(givesUp('その情報は確認できません。'), true);
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

/**
 * Windows の work（run 42466889666）: 「明日の東京の天気は?」のあとの「明日の天気は?」で、挙げる段のあと約 8 秒（取る段の時間切れ）
 * 空いてから答えに入り、天気が載らなかった（入力 215 トークン。一つ目は 394）。取る段の失敗は黙って捨てられ、記録にも何も無かった。
 * 天気の一言は、挙げる段・前の回・蔵の経験の件に関わらず毎回取りに行き、落ちたら取り直し、何をしたかを記録に書く。
 */
describe('天気の一言は毎回取りに行き、この回に載せる', () => {
  async function session(opts: { failFirst: number; shelfNote?: boolean }) {
    const systems: string[] = [];
    const logs: string[] = [];
    const inner: ChatProvider = {
      id: 'fake', locality: 'local',
      async health() { return { ok: true }; },
      async listModels() { return [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }]; },
      async *chat(req): AsyncIterable<ProviderChunk> {
        systems.push(String(req.system ?? ''));
        yield { type: 'text', delta: '答え' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const om = fakeOpenMeteo();
    let fails = 0;
    const flaky = (async (input: string | URL, init?: RequestInit) => {
      // 二つ目の問いの最初の取り方を、時間切れで落とす
      if (fails < opts.failFirst && om.calls.length >= 2) { fails += 1; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
      return om.impl(input, init);
    }) as typeof fetch;
    const shelf = new KnowledgeShelf(join(await tempDir('wx-'), 'k'));
    // 前の回の経験の件（言葉が重なる）。天気の代わりにこれを当ててはいけない
    if (opts.shelfNote) await shelf.upsert({ question: '明日の天気を確認する依頼に対して', answer: 'ツールを使って確かめる', sourceUrl: 'aas:experience', fetchedAt: new Date().toISOString() });
    const registry = new ProviderRegistry();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m'], {
      shelf,
      // 小さいモデルの挙げ方（日付で言い換える・天気でない問いを混ぜる）
      lister: { list: async () => ['2026年11月9日の天気', '明日の天気を確認する依頼'] },
      source: new DefaultSource({ fetchImpl: flaky }),
      log: (level, m) => logs.push(`${level} ${m}`),
      liveRetryWaitMs: 0,
    }));
    const messages: Message[] = [];
    async function ask(m: Message) {
      messages.push(m);
      const before = systems.length;
      for await (const ev of new ChatOrchestrator(registry).run({ candidates: ['network:network'], messages: [...messages] } as never, new AbortController().signal)) void ev;
      messages.push({ role: 'assistant', content: '答え' });
      return systems.slice(before).join('|');
    }
    return { ask, logs, om };
  }

  test('場所つきのあとの場所の無い問いで、一度目の取得が時間切れでも取り直して載せる', async () => {
    const s = await session({ failFirst: 1, shelfNote: true });
    assert.match(await s.ask({ role: 'user', content: '明日の東京の天気は?' }), /東京の2026-11-08.*雨/);
    const second = await s.ask({ role: 'user', content: '明日の天気は?' });
    assert.match(second, /東京の2026-11-08.*雨/, `二つ目に天気が載っていない: ${second}`);
    assert.ok(s.logs.some((l) => /^warn ネットワーク: 今の事実を取れませんでした（1 回目）: failed/.test(l)), s.logs.join('\n'));
    assert.ok(s.logs.some((l) => /^info ネットワーク: 今の事実を取りました（2 回目）: https:\/\/api\.open-meteo\.com/.test(l)), s.logs.join('\n'));
    assert.ok(s.logs.some((l) => /要る事実 \[\]、今の事実 "明日の天気は\?"/.test(l)), s.logs.join('\n'));
    assert.ok(s.logs.some((l) => /載せた事実 \d+ 件: "明日の天気は\?"/.test(l)), s.logs.join("\n"));
  });

  test('取り直しても取れなければ、取れなかったと記録に書く（黙って捨てない）', async () => {
    const s = await session({ failFirst: 99 });
    await s.ask({ role: 'user', content: '明日の東京の天気は?' });
    await s.ask({ role: 'user', content: '明日の天気は?' });
    assert.equal(s.logs.filter((l) => /今の事実を取れませんでした/.test(l)).length, 3, s.logs.join('\n'));
  });

  test('押し戻しの回でも、押し戻しの文ではなく利用者の一言で天気を取って載せる', async () => {
    const s = await session({ failFirst: 0 });
    await s.ask({ role: 'user', content: '明日の天気は?' });
    const nudged = await s.ask({ role: 'user', nudge: true, content: giveUpNudge(false) });
    assert.match(nudged, /東京の2026-11-08.*雨/, `押し戻しの回に天気が載っていない: ${nudged}`);
  });

  test('Windows の work の諦めの答えを、試さずに分からないと言ったと読む', () => {
    assert.equal(givesUp('知識の蔵に「明日の天気」のデータはありません。\n「今」の日付（2026 年 11 月 8 日）から明日（11 月 9 日）の気象情報を取得するには、外部の気象データや天気予報サービスにアクセスする必要があります。\n知識の蔵に気象データが載っていないため、その情報を取得することはできません。'), true);
    assert.equal(givesUp('2026 年 11 月 9 日（月）の天気は、知識の蔵から確認できません。'), true);
  });
});
