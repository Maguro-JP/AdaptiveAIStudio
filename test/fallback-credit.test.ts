/**
 * 途中で別のモデルへ移った回の成績を、答えたモデルに付ける。
 *
 * ここは候補の**先頭**に付けていた。移った回の成否と速さが、
 * **一度も答えていないモデルの成績**になる。次にどのモデルを使うかは
 * その数字で決まる（`autopilot`）ので、付け先を間違えると、
 * 以後ずっと間違った方を選び続ける。直らない種類の間違い。
 *
 * 速さも、最初の候補が落ちるまでの時間（やり直しの待ちを含む）を混ぜていた。
 * 混ぜたぶん遅く見えるので、**答えた側が遅いことにされる。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const state = await tempDir('aas-fallback-');
process.env.AAS_STATE_DIR = state;
const { Session } = await import('../src/core/session.ts');

interface Stat { modelId: string; successes: number; failures: number; measuredTps?: number }

/** 溜まった実測を読む。次のモデル選びがこれを見る。 */
async function stats(): Promise<Stat[]> {
  const raw = await readFile(join(state, 'metrics.json'), 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as Stat[] | { stats?: Stat[] };
  return Array.isArray(parsed) ? parsed : (parsed.stats ?? []);
}

describe('移った回の成績は、答えたモデルに付く', () => {
  test('**答えたのは二つ目。成績も二つ目に付く**', async () => {
    // 一つ目は 500（やり直したうえで諦め、二つ目へ移る）。二つ目が答える。
    const first = await startFakeServer({ kind: 'status', status: 500 });
    // 一文字ずつ流す。速さが測れる長さ（20 トークン以上・1 秒以上）にする。
    // 一文字ずつ、ゆっくり流す。**速さが測れる形にしないと、下の比べが
    // 丸ごと飛ぶ**（`speedOf` は 1 秒未満・20 トークン未満では数えない。
    // 4ms で書いたときに実際に飛んで、測り始めを戻しても通った）。
    const second = await startFakeServer({ kind: 'echo', trickleMs: 12 });
    const root = await tempDir('aas-fallback-root-');
    try {
      const session = await Session.create({
        providers: [
          { id: 'a', kind: 'openai-compatible', baseUrl: first.baseUrl, locality: 'cloud', models: ['m'] },
          { id: 'b', kind: 'openai-compatible', baseUrl: second.baseUrl, locality: 'cloud', models: ['m'] },
        ],
        candidates: ['a:m', 'b:m'],
        runtime: { kind: 'none' },
        agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 1 },
        initiative: { enabled: false },
      } as never, { approve: () => Promise.resolve(true) });

      const began = Date.now();
      let settled: { model?: string; tps?: number; outputTokens?: number } | undefined;
      let moved = false;
      for await (const ev of session.send('1234567890'.repeat(12))) {
        if (ev.type === 'fallback') moved = true;
        if (ev.type === 'settled') settled = ev as typeof settled;
      }
      const whole = (Date.now() - began) / 1000;
      await session.close();

      assert.ok(moved, '移っていない（この試験の前提が崩れている）');
      assert.equal(settled?.model, 'b:m', `答えたモデルを間違えている: ${settled?.model}`);

      const got = await stats();
      const a = got.find((s) => s.modelId === 'a:m');
      const b = got.find((s) => s.modelId === 'b:m');
      assert.ok(b, `答えたモデルの成績が無い: ${JSON.stringify(got)}`);
      assert.equal(b.successes, 1, `答えたモデルに成功が付いていない: ${JSON.stringify(b)}`);
      assert.ok((a?.successes ?? 0) === 0,
        `答えていないモデルに成功が付いている: ${JSON.stringify(a)}`);

      /*
       * 速さは、**答えた側の分だけ**で数えていること。
       *
       * 時間そのものを閾値にしない（機械で変わる）。全体で割った値と比べる
       * ＝混ぜていれば必ず小さくなる、という**関係**で見る。
       */
      // **飛ばさない。**測れていなければ、この試験は何も見ていない。
      assert.ok(settled?.tps !== undefined && settled.outputTokens !== undefined,
        `速さが測れていない（この試験が何も見ていない）: ${JSON.stringify(settled)}`);
      /*
       * 混ぜていれば、全体で割った値とほぼ同じになる。**比で見る。**
       *
       * 一つ目のやり直しの待ちは決まっている（500ms + 1000ms）。二つ目は
       * 125 文字 × 12ms。どちらも機械の速さに依らないので、比はおよそ 2 倍。
       * 実測: 直したとき 2.00（26.9 tok/s 対 13.5）、混ぜたとき 1.00（13.4 対 13.4）。
       * 1.4 倍で切れば、どちらも取り違えない。
       */
      const mixed = settled.outputTokens / whole;
      assert.ok(settled.tps > mixed * 1.4,
        `落ちた側の時間を混ぜている: ${settled.tps} tok/s（全体で割ると ${mixed.toFixed(1)}）`);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
