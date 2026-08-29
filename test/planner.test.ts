/**
 * 実行可能性プランナの検証。
 * 「載らないから動かない」を返さないこと、劣化の順序が正しいことを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planExecution, estimateDuration } from '../src/runtime/planner.ts';
import { REFERENCE_MACHINE, GB, QUANT_BITS, type MachineSpec } from '../src/runtime/spec.ts';
import { KNOWN_MODELS } from '../src/runtime/catalog.ts';

const machine = REFERENCE_MACHINE;

describe('実行可能性プランナ', () => {
  test('小さいモデルは全層GPUに載る', () => {
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:7b']!, machine });
    assert.equal(p.placement, 'fullGpu');
    assert.equal(p.gpuLayers, p.totalLayers);
    assert.equal(p.degradations.length, 0);
    assert.ok(p.estimatedTps > 20, `速度見積りが低すぎる: ${p.estimatedTps}`);
  });

  test('32Bは「載らない」ではなく部分オフロードの計画が返る', () => {
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine });
    assert.equal(p.placement, 'partialOffload');
    assert.ok(p.gpuLayers > 0 && p.gpuLayers < p.totalLayers);
    assert.ok(p.estimatedTps > 0, '動かせない計画を返している');
    // 遅いが実用範囲であること
    assert.ok(p.estimatedTps >= 1 && p.estimatedTps <= 10, `想定外の速度: ${p.estimatedTps}`);
  });

  test('32Bは量子化を下げずに済む（品質を落とさない劣化で足りる）', () => {
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine });
    assert.equal(p.quant, 'Q4_K_M');
    assert.equal(p.degradations.some((d) => d.includes('量子化')), false);
  });

  test('VRAM/RAMの上限を超える計画は返さない', () => {
    for (const model of Object.values(KNOWN_MODELS)) {
      const p = planExecution({ model, machine });
      assert.ok(p.vramUsedBytes <= machine.vramBytes, `${model.id}: VRAM超過`);
      assert.ok(p.ramUsedBytes <= machine.ramBytes, `${model.id}: RAM超過`);
    }
  });

  test('MoEは同じ総サイズの通常モデルより大幅に速い', () => {
    const dense = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine });
    const moe = planExecution({ model: KNOWN_MODELS['qwen3:30b-a3b']!, machine });
    assert.ok(moe.estimatedTps > dense.estimatedTps * 3,
      `MoEの優位が出ていない: dense=${dense.estimatedTps} moe=${moe.estimatedTps}`);
  });

  test('劣化の順序: GPU層数 → KV量子化 → context → 量子化', () => {
    // VRAMを絞ると、まずGPU層数が減る（量子化は下げない）
    const tight: MachineSpec = { ...machine, vramBytes: 6 * GB };
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5:14b']!, machine: tight });
    assert.ok(p.degradations.some((d) => d.includes('GPU層数')));
    assert.equal(p.degradations.some((d) => d.includes('量子化を')), false);
  });

  test('RAMが厳しいと量子化を下げる（最後の手段として使われる）', () => {
    const small: MachineSpec = { ...machine, ramBytes: 16 * GB };
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine: small });
    assert.ok(p.degradations.some((d) => d.includes('量子化')), '量子化を下げていない');
    assert.ok(p.estimatedTps > 0);
  });

  test('量子化の低下を禁じても計画は返る（縮めるかディスクへ）', () => {
    const small: MachineSpec = { ...machine, ramBytes: 8 * GB, vramBytes: 4 * GB };
    const p = planExecution({
      model: KNOWN_MODELS['llama3.1:70b']!, machine: small, allowQuantDowngrade: false,
    });
    assert.equal(p.quant, 'Q4_K_M');
    assert.ok(p.estimatedTps > 0);
    assert.ok(p.placement === 'diskMmap' || p.placement === 'cpuOnly' || p.placement === 'partialOffload');
  });

  test('極端に貧弱な環境でもディスク実行の計画を返す（拒否しない）', () => {
    const potato: MachineSpec = {
      vramBytes: 2 * GB, ramBytes: 8 * GB,
      ramBandwidthBytesPerSec: 20 * GB, vramBandwidthBytesPerSec: 100 * GB,
      diskBandwidthBytesPerSec: 1 * GB,
    };
    const p = planExecution({ model: KNOWN_MODELS['llama3.1:70b']!, machine: potato });
    assert.ok(p.estimatedTps > 0, '「動かせない」を返している');
    assert.ok(p.degradations.length > 0);
  });

  test('待ち時間を人間が読める形で予告できる', () => {
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine });
    const d = estimateDuration(p, 1000);
    assert.match(d, /秒|分|時間/);
  });

  test('KVキャッシュはcontextに比例して増える', () => {
    const short = planExecution({
      model: KNOWN_MODELS['qwen2.5-coder:7b']!, machine, desiredContext: 4096 });
    const long = planExecution({
      model: KNOWN_MODELS['qwen2.5-coder:7b']!, machine, desiredContext: 16384 });
    assert.ok(long.vramUsedBytes > short.vramUsedBytes);
  });
});
