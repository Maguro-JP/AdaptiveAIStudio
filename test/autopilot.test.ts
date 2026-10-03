/**
 * 自動操縦の検証。
 * 利用者が何も設定しなくても妥当なモデルが選ばれ、
 * 実測が溜まれば裏で乗り換わることを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Autopilot } from '../src/runtime/autopilot.ts';
import { MetricsStore } from '../src/runtime/metrics.ts';
import { REFERENCE_MACHINE } from '../src/runtime/spec.ts';
import { inferSpec } from '../src/runtime/infer.ts';
import type { ModelDescriptor } from '../src/providers/contract.ts';

const model = (name: string): ModelDescriptor => ({
  id: `ollama:${name}`, providerId: 'ollama', model: name,
  displayName: name, locality: 'local',
});

function pilot(margin = 0.25) {
  return new Autopilot({
    machine: REFERENCE_MACHINE,
    metrics: new MetricsStore('/dev/null'),
    switchMarginRatio: margin,
  });
}

describe('諸元の推定', () => {
  test('モデル名から規模と量子化を読み取る', () => {
    const s = inferSpec('qwen2.5-coder:32b-q4_K_M')!;
    assert.equal(s.paramsB, 32);
    assert.equal(s.layers, 64);
  });

  test('MoE表記から活性パラメータを読み取る', () => {
    const s = inferSpec('qwen3:30b-a3b')!;
    assert.equal(s.paramsB, 30);
    assert.equal(s.activeParamsB, 3);
  });

  test('専門家の数×大きさ（8x7b）を、一つの大きさと読まない', () => {
    // 7b に当たって 7B と読み、実際は 47B ほどあるものを小さいと見て選んでいた。
    const s = inferSpec('mixtral-8x7b-instruct-v0.1.Q4_K_M.gguf')!;
    assert.ok(s.paramsB >= 40, `小さく読んでいる: ${s.paramsB}`);
    assert.equal(s.activeParamsB, 14);
    // 普通の名前は今までどおり（対）。
    assert.equal(inferSpec('llama3:8b')!.activeParamsB, undefined);
  });

  test('規模が読めない名前は候補にしない', () => {
    assert.equal(inferSpec('mystery-model'), undefined);
  });

  test('量子化の指定を読み取る', () => {
    assert.ok(inferSpec('llama3:8b-q3_K_M')!.bitsPerWeight < inferSpec('llama3:8b')!.bitsPerWeight);
  });
});

describe('自動選択', () => {
  test('RAM に入らないモデルを、量子化を下げた速さで見て選ばない（下げたファイルは無く、ディスクから読んで遅い）', () => {
    const p = new Autopilot({
      machine: { vramBytes: 0, ramBytes: 16 * 1024 ** 3, ramBandwidthBytesPerSec: 70 * 1024 ** 3, vramBandwidthBytesPerSec: 0, diskBandwidthBytesPerSec: 3 * 1024 ** 3 },
      metrics: new MetricsStore('/dev/null'),
    });
    p.register([model('qwen2.5-coder:7b'), model('qwen2.5-coder:32b')]);
    assert.equal(p.select()?.modelId, 'ollama:qwen2.5-coder:7b', JSON.stringify(p.select()));
  });

  test('設定なしでも、入っているモデルから最良を選ぶ', () => {
    const p = pilot();
    p.register([model('qwen2.5-coder:7b'), model('qwen3:30b-a3b'), model('qwen2.5-coder:32b')]);
    const sel = p.select();
    assert.equal(sel?.modelId, 'ollama:qwen3:30b-a3b');
    assert.match(sel!.reason, /起動時の自動選択/);
  });

  test('カタログに無いモデルも候補に入る', () => {
    const p = pilot();
    p.register([model('some-new-model:14b'), model('qwen2.5-coder:7b')]);
    assert.equal(p.knownCount, 2);
    assert.ok(p.select());
  });

  test('モデルが1つも無ければ選択しない', () => {
    assert.equal(pilot().select(), undefined);
  });

  test('選択理由に1件あたりの所要時間が含まれる', () => {
    const p = pilot();
    p.register([model('qwen2.5-coder:7b')]);
    assert.match(p.select()!.reason, /1件あたり約\d+秒/);
  });
});

describe('裏での乗り換え', () => {
  test('現行が実測で悪ければ、より良いモデルへ乗り換える', async () => {
    const metrics = new MetricsStore('/dev/null');
    const p = new Autopilot({ machine: REFERENCE_MACHINE, metrics, switchMarginRatio: 0.1 });
    p.register([model('qwen2.5-coder:7b'), model('qwen3:30b-a3b')]);

    const first = p.select()!;
    // 現行モデルが繰り返し失敗し、しかも誤りを見逃していたと記録する
    for (let i = 0; i < 10; i += 1) {
      await p.record({
        modelId: first.modelId, success: i < 2, defect: i < 2,
        outputTokens: 500, seconds: 20,
      });
    }
    const next = p.select()!;
    assert.notEqual(next.modelId, first.modelId, '実測が悪いのに乗り換えていない');
    assert.equal(next.switched, true);
  });

  test('差が小さければ乗り換えない（切替の暴れを防ぐ）', async () => {
    const metrics = new MetricsStore('/dev/null');
    const p = new Autopilot({ machine: REFERENCE_MACHINE, metrics, switchMarginRatio: 0.9 });
    p.register([model('qwen2.5-coder:7b'), model('qwen3:30b-a3b')]);
    const first = p.select()!;
    // 現行が少し劣る記録。順位は入れ替わるが、差は小さい。
    for (let i = 0; i < 3; i += 1) {
      await p.record({ modelId: first.modelId, success: false, outputTokens: 100, seconds: 5 });
    }
    const next = p.select()!;
    assert.equal(next.modelId, first.modelId);
    assert.equal(next.switched, false);
    assert.match(next.reason, /差が小さい/);
  });

  test('実測を重ねても、良い記録なら同じモデルを使い続ける', async () => {
    const metrics = new MetricsStore('/dev/null');
    const p = new Autopilot({ machine: REFERENCE_MACHINE, metrics });
    p.register([model('qwen2.5-coder:7b'), model('qwen3:30b-a3b')]);
    const first = p.select()!;
    for (let i = 0; i < 20; i += 1) {
      await p.record({ modelId: first.modelId, success: true, outputTokens: 500, seconds: 15 });
    }
    assert.equal(p.select()!.modelId, first.modelId);
  });

  test('候補の順位と理由を一覧で説明できる', () => {
    const p = pilot();
    p.register([model('qwen2.5-coder:7b'), model('qwen3:30b-a3b'), model('qwen2.5-coder:32b')]);
    const rows = p.explain();
    assert.equal(rows.length, 3);
    assert.ok(rows[0]!.expectedSeconds <= rows[1]!.expectedSeconds);
    assert.match(rows[0]!.reason, /tok\/s/);
  });
});
