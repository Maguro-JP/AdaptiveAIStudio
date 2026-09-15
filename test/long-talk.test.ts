/**
 * 長く話し続けても、送る形が崩れない。
 *
 * 窓に収まらなくなると刈る。刈り方を間違えると、**道具の呼び出しが無いのに
 * 結果だけが残る**。OpenAI 互換の口はその形を受け取らずに 400 を返し、
 * 画面には「打っても返事が来ない」としか出ない。原因に辿り着けない。
 *
 * 毎日使えば必ずここに来る。一往復ずつ流して、送った中身を毎回見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { fitToWindow, tokenBudget } from '../src/agent/window.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';

let fake: FakeServer;
let root = '';

before(async () => {
  root = await tempDir('aas-long-');
  await writeFile(join(root, 'a.txt'), `${'ここが中身です。'.repeat(400)}\n`);
  fake = await startFakeServer({ kind: 'stream', text: 'はい' });
});
after(async () => { await fake.close(); });

/** 送った中身の形を確かめる。**呼び出しの無い結果を残していないか。** */
function shapeProblems(bodies: readonly unknown[]): string[] {
  const bad: string[] = [];
  bodies.forEach((b, at) => {
    const messages = (b as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    const called = new Set<string>();
    messages.forEach((m, i) => {
      for (const c of (m.tool_calls as Array<{ id?: string }> | undefined) ?? []) {
        if (c.id) called.add(c.id);
      }
      if (m.role === 'tool') {
        const id = m.tool_call_id as string | undefined;
        if (!id || !called.has(id)) {
          bad.push(`${at} 回目の ${i} 番目: 呼び出しの無い結果（${id ?? 'id なし'}）`);
        }
      }
    });
    // 空の中身だけの assistant（道具も本文も無い）を送っていないか。
    for (const m of messages) {
      if (m.role === 'assistant' && !m.content && !(m.tool_calls as unknown[] | undefined)?.length) {
        bad.push(`${at} 回目: 中身も呼び出しも無い返事を送っている`);
      }
    }
  });
  return bad;
}

describe('長く話しても、形が崩れない', () => {
  test('狭い窓で 12 往復しても、送る形が崩れない', async () => {
    const session = await Session.create({
      ...DEFAULT_CONFIG,
      providers: [{
        id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl,
        locality: 'local', models: ['m'],
      }],
      candidates: ['local:m'],
      // 狭い窓。すぐに刈り込みが要る形にする。
      runtime: { contextSize: 4096 },
      agent: { root, approval: 'auto', maxTurns: 3, verify: { enabled: false } },
      initiative: { enabled: false },
    } as never, { approve: () => Promise.resolve(true) });

    let trimmed = 0;
    let droppedTotal = 0;

    /*
     * 最初の一往復だけ道具を呼ばせる。**その対が、あとで刈られる。**
     * 刈り方を間違えると、呼び出しの無い結果だけが残る。
     * （作り物の相手は、履歴に結果があると二度目の呼び出しを返さないので、
     *   道具の対はここで一組だけ作る）
     */
    fake.setBehavior({
      kind: 'toolcall', name: 'read_file', args: { path: 'a.txt' }, then: '読みました。',
    });
    for await (const _ of session.send('a.txt を読んで')) { /* 流し切る */ }

    // あとは大きな依頼を続ける。窓はすぐに一杯になる。
    const long = 'これは長めの依頼です。前の話を踏まえて続けてください。'.repeat(40);
    for (let turn = 0; turn < 12; turn += 1) {
      fake.setBehavior({ kind: 'stream', text: `${turn} 回目の返事です。${'説明。'.repeat(60)}` });
      for await (const ev of session.send(`${turn} 回目です。${long}`)) {
        if (ev.type === 'trimmed') { trimmed += 1; droppedTotal += (ev as { dropped: number }).dropped; }
      }
    }

    const bad = shapeProblems(fake.bodies);
    assert.deepEqual(bad.slice(0, 5), [], `送る形が崩れている: ${bad.length} 件`);
    assert.ok(trimmed > 0, '狭い窓なのに一度も刈っていない（この検査が効いていない）');
    assert.ok(droppedTotal > 0, '刈ったのに、落とした数を数えていない');
  });

  test('**刈ったことを、画面へ出す**', async () => {
    // 黙って落とすと、モデルは「読んだはずのもの」を読んでいないまま進む。
    // 人からは、急に話が噛み合わなくなったようにしか見えない。
    const { readFile } = await import('node:fs/promises');
    const app = await readFile(join(process.cwd(), 'src/ui/web/panels.js'), 'utf8');
    assert.ok(app.includes('往復を省きました'), '画面に出す所が無い');
  });
});

/**
 * 刈った後に、宙に浮いた道具の結果を残さない。
 *
 * Session 越しに試すと道が細く、壊しても出てこなかった。
 * **刈り込みそのものに、無作為な履歴を直接ぶつける。**
 * 入力をこちらで選ぶと、通るものを選んだのと区別が付かない。
 */
describe('刈った後の形（無作為にぶつける）', () => {
  /** 種を固定した乱数。落ちたものを手元で再現できるように。 */
  function makeRandom(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
  }

  /** それらしい履歴を作る。道具の対を混ぜる。 */
  function history(rand: () => number, rounds: number): ProviderMessage[] {
    const out: ProviderMessage[] = [];
    for (let i = 0; i < rounds; i += 1) {
      out.push({ role: 'user', content: `依頼${i}: ${'あ'.repeat(Math.floor(rand() * 300))}` });
      const calls = Math.floor(rand() * 3);
      if (calls > 0) {
        const ids = Array.from({ length: calls }, (_, k) => `c${i}_${k}`);
        out.push({
          role: 'assistant',
          content: '',
          toolCalls: ids.map((id) => ({ id, name: 'read_file', args: { path: 'a.ts' } })),
        });
        for (const id of ids) {
          out.push({ role: 'tool', content: 'い'.repeat(Math.floor(rand() * 800)), toolCallId: id });
        }
      }
      out.push({ role: 'assistant', content: `返事${i}: ${'う'.repeat(Math.floor(rand() * 200))}` });
    }
    return out;
  }

  /** 宙に浮いた結果を探す。 */
  function orphans(messages: readonly ProviderMessage[]): string[] {
    const called = new Set<string>();
    const bad: string[] = [];
    messages.forEach((m, i) => {
      for (const c of m.toolCalls ?? []) called.add(c.id);
      if (m.role === 'tool') {
        const id = (m as { toolCallId?: string }).toolCallId;
        if (!id || !called.has(id)) bad.push(`${i} 番目: 呼び出しの無い結果（${id ?? 'id なし'}）`);
      }
    });
    return bad;
  }

  test('**どんな履歴・どんな窓でも、宙に浮いた結果を残さない**', () => {
    const rand = makeRandom(20260906);
    let checked = 0;
    let trimmedAtLeastOnce = 0;
    for (let round = 0; round < 300; round += 1) {
      const h = history(rand, 2 + Math.floor(rand() * 40));
      const budget = tokenBudget(1024 + Math.floor(rand() * 8000));
      const got = fitToWindow(h, budget);
      const bad = orphans(got.messages);
      assert.deepEqual(bad, [], `宙に浮いた結果が残っている（${round} 回目・予算 ${budget}）`);
      checked += 1;
      if (got.trimmed) trimmedAtLeastOnce += 1;
    }
    assert.equal(checked, 300);
    // **刈らない場合ばかりだと、この検査は何も見ていない。**
    assert.ok(trimmedAtLeastOnce > 30, `刈った回が少なすぎる: ${trimmedAtLeastOnce}/300`);
  });
});
