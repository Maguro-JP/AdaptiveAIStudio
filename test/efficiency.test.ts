/**
 * 効率計算の検証。
 * ローカルでは単価がゼロなので、選ぶ基準は「1件完了までの実時間」だけ。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rank, choose, type Candidate } from '../src/runtime/efficiency.ts';
import { MetricsStore } from '../src/runtime/metrics.ts';
import { planExecution } from '../src/runtime/planner.ts';
import { REFERENCE_MACHINE } from '../src/runtime/spec.ts';
import { KNOWN_MODELS } from '../src/runtime/catalog.ts';

const machine = REFERENCE_MACHINE;
const planOf = (id: string) => planExecution({ model: KNOWN_MODELS[id]!, machine });

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  modelId: id, plan: planOf(id), loaded: true, ...over,
});

describe('効率計算', () => {
  test('やり直し算だけなら、速い弱モデルが勝つことがある', () => {
    // 失敗が必ずその場で検知される（見逃しゼロ）なら、
    // 10倍速いモデルは成功率が低くても総時間で勝つ。これは正しい計算。
    const results = rank({
      candidates: [
        cand('qwen2.5-coder:7b', {
          stats: { modelId: 'qwen2.5-coder:7b', measuredTps: 41, successes: 3, failures: 12, defects: 0 },
        }),
        cand('qwen2.5-coder:32b', {
          stats: { modelId: 'qwen2.5-coder:32b', measuredTps: 3, successes: 14, failures: 1, defects: 0 },
        }),
      ],
      expectedTokens: 1200,
    });
    assert.equal(results[0]!.modelId, 'qwen2.5-coder:7b');
  });

  test('誤りが検知されず通る割合を入れると、判断が逆転する', () => {
    // 弱いモデルの本当の危険は「失敗」ではなく「間違ったまま通ること」。
    const results = rank({
      candidates: [
        cand('qwen2.5-coder:7b', {
          // 3件通ったが、うち2件は後で誤りが判明した
          stats: { modelId: 'qwen2.5-coder:7b', measuredTps: 41, successes: 3, failures: 12, defects: 2 },
        }),
        cand('qwen2.5-coder:32b', {
          stats: { modelId: 'qwen2.5-coder:32b', measuredTps: 3, successes: 14, failures: 1, defects: 0 },
        }),
      ],
      expectedTokens: 1200,
    });
    assert.equal(results[0]!.modelId, 'qwen2.5-coder:32b',
      '見逃しコストを入れても弱いモデルが選ばれている');
  });

  test('成功率の差が大きければ、遅いモデルが選ばれる', () => {
    const results = rank({
      candidates: [
        cand('qwen2.5-coder:7b', {
          stats: { modelId: 'qwen2.5-coder:7b', measuredTps: 41, successes: 1, failures: 30 },
        }),
        cand('qwen2.5-coder:32b', {
          stats: { modelId: 'qwen2.5-coder:32b', measuredTps: 3, successes: 20, failures: 0 },
        }),
      ],
      expectedTokens: 600,
    });
    assert.equal(results[0]!.modelId, 'qwen2.5-coder:32b',
      '成功率が極端に低い高速モデルを選んでしまっている');
  });

  test('MoEは速度と規模を両立するので最良になりやすい', () => {
    const best = choose({
      candidates: [
        cand('qwen2.5-coder:7b'),
        cand('qwen2.5-coder:32b'),
        cand('qwen3:30b-a3b'),
      ],
    });
    assert.equal(best?.modelId, 'qwen3:30b-a3b');
  });

  test('未ロードのモデルには切替コストが乗る', () => {
    const loaded = rank({
      candidates: [cand('qwen2.5-coder:7b', { loaded: true })],
      expectedTokens: 300,
    })[0]!;
    const cold = rank({
      candidates: [cand('qwen2.5-coder:7b', { loaded: false })],
      expectedTokens: 300,
    })[0]!;
    assert.equal(loaded.swapSeconds, 0);
    assert.ok(cold.swapSeconds > 0);
    assert.ok(cold.expectedSeconds > loaded.expectedSeconds);
  });

  test('短い作業では、切替コストが生成時間を上回り「今のモデルで済ませる」が正解になる', () => {
    const results = rank({
      // 実績を揃え、差を「速度」と「ロード済みか」だけにする
      candidates: [
        cand('qwen2.5-coder:32b', {
          loaded: true,
          stats: { modelId: 'qwen2.5-coder:32b', successes: 20, failures: 0, defects: 0 },
        }),
        cand('qwen2.5-coder:7b', {
          loaded: false,
          stats: { modelId: 'qwen2.5-coder:7b', successes: 20, failures: 0, defects: 0, loadSeconds: 60 },
        }),
      ],
      expectedTokens: 80, // 短い作業
    });
    assert.equal(results[0]!.modelId, 'qwen2.5-coder:32b',
      '短い作業のためにモデルを載せ替えてしまっている');
  });

  test('実測が少ないうちは事前値と混ぜ、1回の失敗で判断が振れない', () => {
    const oneFailure = rank({
      candidates: [cand('qwen2.5-coder:32b', {
        stats: { modelId: 'qwen2.5-coder:32b', successes: 0, failures: 1 },
      })],
    })[0]!;
    assert.equal(oneFailure.basis, 'mixed');
    assert.ok(oneFailure.successRate > 0.3,
      `1回の失敗で成功率が潰れている: ${oneFailure.successRate}`);
  });

  test('十分な試行が溜まれば実測のみで判断する', () => {
    const r = rank({
      candidates: [cand('qwen2.5-coder:7b', {
        stats: { modelId: 'qwen2.5-coder:7b', successes: 8, failures: 2 },
      })],
    })[0]!;
    assert.equal(r.basis, 'measured');
    assert.equal(r.successRate, 0.8);
  });

  test('選択理由が人間に読める形で出る', () => {
    const r = choose({ candidates: [cand('qwen3:30b-a3b')] })!;
    assert.match(r.reason, /tok\/s/);
    assert.match(r.reason, /成功率/);
    assert.match(r.reason, /見逃し/);
  });

  test('見逃しコストをゼロにすれば、純粋なやり直し算に戻る', () => {
    const withPenalty = rank({
      candidates: [cand('qwen2.5-coder:7b', {
        stats: { modelId: 'qwen2.5-coder:7b', measuredTps: 41, successes: 3, failures: 12, defects: 3 },
      })],
      expectedTokens: 1200,
    })[0]!;
    const without = rank({
      candidates: [cand('qwen2.5-coder:7b', {
        stats: { modelId: 'qwen2.5-coder:7b', measuredTps: 41, successes: 3, failures: 12, defects: 3 },
      })],
      expectedTokens: 1200,
      defectPenaltySeconds: 0,
    })[0]!;
    assert.ok(withPenalty.expectedSeconds > without.expectedSeconds);
    assert.equal(without.defectSeconds, 0);
  });
});

describe('実測の蓄積', () => {
  test('記録して読み直せる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aas-metrics-'));
    const path = join(dir, 'metrics.json');
    const store = new MetricsStore(path);
    await store.load();

    store.record({ modelId: 'local:m', success: true, outputTokens: 400, seconds: 10 });
    store.record({ modelId: 'local:m', success: false, outputTokens: 200, seconds: 5 });
    await store.save();

    const reloaded = new MetricsStore(path);
    await reloaded.load();
    const s = reloaded.get('local:m')!;
    assert.equal(s.successes, 1);
    assert.equal(s.failures, 1);
    assert.ok(s.measuredTps && s.measuredTps > 0);
  });

  test('実測tok/sは移動平均で更新され、外れ値で飛ばない', () => {
    const store = new MetricsStore('/dev/null');
    store.record({ modelId: 'm', success: true, outputTokens: 400, seconds: 10 }); // 40 tok/s
    store.record({ modelId: 'm', success: true, outputTokens: 400, seconds: 400 }); // 1 tok/s の外れ値
    const s = store.get('m')!;
    assert.ok(s.measuredTps! > 20, `外れ値に引きずられすぎ: ${s.measuredTps}`);
  });

  test('記録が無くても落ちない', async () => {
    const store = new MetricsStore('/nonexistent/path/metrics.json');
    await store.load();
    assert.equal(store.all().length, 0);
    assert.match(store.report(), /まだありません/);
  });

  test('見逃しを記録できる', () => {
    const store = new MetricsStore('/dev/null');
    store.record({ modelId: 'm', success: true, defect: true, outputTokens: 100, seconds: 5 });
    assert.equal(store.get('m')!.defects, 1);
    assert.equal(store.get('m')!.successes, 1);
  });

  test('レポートは1件完了までの時間順に並ぶ', () => {
    const store = new MetricsStore('/dev/null');
    for (let i = 0; i < 10; i += 1) {
      store.record({ modelId: 'fast-but-wrong', success: i < 2, outputTokens: 400, seconds: 10 });
      store.record({ modelId: 'slow-but-right', success: true, outputTokens: 400, seconds: 100 });
    }
    const report = store.report();
    // やり直し算のみでは fast-but-wrong (50秒) が上に来るのが正しい。
    // 見逃しコストは効率計算(rank)側で扱う。
    assert.ok(report.indexOf('fast-but-wrong') < report.indexOf('slow-but-right'),
      `1件完了までの時間順になっていない:\n${report}`);
  });
});
