/**
 * 実行可能性プランナの検証。
 * 「載らないから動かない」を返さないこと、劣化の順序が正しいことを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planExecution, estimateDuration } from '../src/runtime/planner.ts';
import { REFERENCE_MACHINE, GB, MB, QUANT_BITS, type MachineSpec, type ModelSpec, weightBytes, bytesPerLayer, kvCacheBytes } from '../src/runtime/spec.ts';
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

  test('劣化の記録は採用した設定のぶんだけ（試行過程を並べない）', () => {
    // 量子化を2段下げて収まった場合、「Q3に下げた」と「IQ2に下げた」の
    // 両方を並べると、実際より劣化が大きく見えてしまう
    const small: MachineSpec = { ...machine, ramBytes: 16 * GB };
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:32b']!, machine: small });
    const quantNotes = p.degradations.filter((d) => d.includes('量子化を'));
    assert.equal(quantNotes.length, 1, `量子化の記録が重複している: ${quantNotes.join(' / ')}`);
    assert.ok(quantNotes[0]!.includes(p.quant), '記録が採用した量子化と一致しない');
  });

  test('GPUが無い環境でも速度0を返さない', () => {
    // vramBandwidth 0 で 0/0 の NaN を作り、速度0＝動かせないと誤判定していた
    const cpuOnly: MachineSpec = {
      vramBytes: 0, ramBytes: 16 * GB,
      ramBandwidthBytesPerSec: 45 * GB, vramBandwidthBytesPerSec: 0,
      diskBandwidthBytesPerSec: 2 * GB,
    };
    const p = planExecution({ model: KNOWN_MODELS['qwen2.5-coder:7b']!, machine: cpuOnly });
    assert.equal(p.placement, 'cpuOnly');
    assert.ok(p.estimatedTps > 0, `GPUなしで速度0を返した: ${p.estimatedTps}`);
    assert.ok(Number.isFinite(p.estimatedTps));
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

/*
 * 計画が本当に載るかを、プランナの外で計算し直して見る。プランナが返す使用量は、プランナ自身の見積もりなので
 * 見積もりを間違えていれば一緒に間違える。ここではファイルの本当の重さと、会話の数ぶんの KV で数える。
 */
const KV_BYTES = { f16: 2, q8_0: 1, q4_0: 0.55 } as const;
function gpuBytesReally(file: ModelSpec, p: ReturnType<typeof planExecution>, sequences = 1): number {
  if (p.gpuLayers === 0) return 0;
  // 量子化を下げた計画なら、下げた先の重さで数える
  const model = p.degradations.some((d) => d.startsWith('量子化を')) ? { ...file, bitsPerWeight: QUANT_BITS[p.quant] } : file;
  return p.gpuLayers * bytesPerLayer(model) + kvCacheBytes(model, p.contextLength, KV_BYTES[p.kvCacheType]) * sequences;
}

describe('計画は、実際に読むファイルと実際に確保する量で載る', () => {
  const f16: ModelSpec = { id: 'f16-7b', paramsB: 7.6, layers: 28, kvHeads: 4, headDim: 128, bitsPerWeight: 16 };

  test('F16 のモデルを Q8_0 の重さで見積もらない（GPU に載せすぎて落ちる）', () => {
    for (const allowQuantDowngrade of [true, false]) {
      const p = planExecution({ model: f16, machine, allowQuantDowngrade });
      assert.ok(gpuBytesReally(f16, p) <= machine.vramBytes - 900 * MB,
        `${p.gpuLayers} 層を GPU に載せる計画だが、本当の重さでは ${(gpuBytesReally(f16, p) / GB).toFixed(1)}GB（allowQuantDowngrade=${allowQuantDowngrade}）`);
    }
  });

  test('量子化を下げないなら、読むファイルの重さのまま見積もる', () => {
    const p = planExecution({ model: f16, machine, allowQuantDowngrade: false });
    assert.equal(p.degradations.some((d) => d.startsWith('量子化を')), false);
    assert.ok(p.ramUsedBytes + p.vramUsedBytes >= weightBytes(f16), '重みの合計がファイルより軽い');
  });

  test('会話の数ぶんの KV を見込む（--ctx-size は context × 会話の数で渡る）', () => {
    for (const model of Object.values(KNOWN_MODELS)) {
      for (const sequences of [1, 2, 4]) {
        const p = planExecution({ model, machine, sequences, desiredContext: 32768 });
        assert.ok(gpuBytesReally(model, p, sequences) <= machine.vramBytes - 900 * MB,
          `${model.id}: 会話 ${sequences} つで ${(gpuBytesReally(model, p, sequences) / GB).toFixed(1)}GB を GPU に置く計画になっている`);
      }
    }
  });

  test('context を縮める前に KV を量子化する（ほぼ落ちない方を先に使う）', () => {
    const model = KNOWN_MODELS['qwen2.5-coder:7b']!;
    const cpu: MachineSpec = {
      vramBytes: 0, vramBandwidthBytesPerSec: 0, ramBandwidthBytesPerSec: 70 * GB,
      // q8_0 の KV なら 8192 がちょうど入る広さ
      ramBytes: 4 * GB + weightBytes(model) + kvCacheBytes(model, 8192, 1) + 1 * MB,
    };
    const p = planExecution({ model, machine: cpu, desiredContext: 8192 });
    assert.equal(p.contextLength, 8192, `context を縮めた: ${p.degradations.join(' / ')}`);
    assert.equal(p.kvCacheType, 'q8_0');
  });
});
