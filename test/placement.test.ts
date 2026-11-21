/**
 * 配置の計画（src/runtime/placement.ts）。
 *
 * メモリより大きいモデルを、読む前に「大きすぎます」で断っていた。いまは、GPU に載るだけ載せ、残りはメモリに置き、
 * 入り切らない分は SSD から読む。断るのは、どう置いても動かないときだけ。機械を並べて、計画がそうなっているかを見る。
 * ここは計算だけなので、走らせる場所で結果が変わらない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPlacement, retryLadder, runLadder, isMemoryFailure, timeoutsFor, describePlacement, placementDetail,
  reportedRam, ramReserve, FIT_LABEL, GIB,
  type PlacementMachine, type PlacementModel,
} from '../src/runtime/placement.ts';
import { swapFreeFromMeminfo, refusalText } from '../src/runtime/placement-machine.ts';

/** 配布元のファイルの大きさと、GGUF の先頭に書いてある値（2026-11-15 に読んだ）。 */
const M9: PlacementModel = { ref: 'Qwen3.5-9B-Q4_K_M.gguf', fileBytes: 5_680_522_464, layers: 32, kvBytesPerToken: 131_072, trainedContext: 262_144, downloaded: true };
const M27: PlacementModel = { ref: 'Qwen3.6-27B-Q4_K_M.gguf', fileBytes: 16_817_244_384, layers: 64, kvBytesPerToken: 262_144, trainedContext: 262_144, downloaded: true };
const MOE: PlacementModel = { ref: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', fileBytes: 22_134_528_992, layers: 40, kvBytesPerToken: 81_920, trainedContext: 262_144, activeRatio: 0.18, downloaded: true };

/** GPU の無い機械。ページングは、決まった大きさ（Linux の swap）で 0。 */
const cpu = (ramGb: number, more: Partial<PlacementMachine> = {}): PlacementMachine => ({ ramBytes: ramGb * GIB, gpus: [], cores: 8, swapBytes: 0, ...more });
/** Windows の形: ページ ファイルが、システムのドライブの空きまで広がる。 */
const windows = (ramGb: number, freeGb: number, vramGb = 0): PlacementMachine => ({
  ramBytes: ramGb * GIB, gpus: vramGb > 0 ? [{ vramBytes: vramGb * GIB, name: 'GPU' }] : [], cores: 8,
  swapGrows: true, systemDiskFreeBytes: freeGb * GIB,
});

describe('GPU の無い機械', () => {
  test('8GB: 9B はメモリに入り切らない分を SSD から読む。断らない', () => {
    const p = planPlacement(M9, windows(8, 100), { context: 32_768, sequences: 2 });
    assert.equal(p.possible, true);
    assert.equal(p.fit, 'ssd');
    assert.equal(p.gpuLayers, 0);
    assert.ok(p.ssdBytes > 0);
    // 入り切らないときは、先にコンテキストウィンドウと並列を縮めている
    assert.equal(p.contextSize, 4096);
    assert.equal(p.sequences, 1);
    assert.ok(p.shrunk.some((s) => s.includes('コンテキストウィンドウを 32768 から 4096 に狭めました')), p.shrunk.join(' / '));
    assert.ok(p.shrunk.some((s) => s.includes('並列を 2 本から 1 本に減らしました')));
    assert.ok(p.shrunk.some((s) => s.includes('SSD から読みます')));
  });

  test('16GB: 9B はメモリに載る（遅い）。27B は Windows なら SSD から読み、swap の無い Linux では入らない', () => {
    const fits = planPlacement(M9, cpu(16), { context: 8192 });
    assert.equal(fits.fit, 'slow');
    assert.equal(fits.ssdBytes, 0);
    assert.equal(fits.contextSize, 8192, '入るものは縮めない');
    assert.deepEqual(fits.shrunk, []);

    const paged = planPlacement(M27, windows(16, 200));
    assert.equal(paged.fit, 'ssd');
    assert.equal(paged.possible, true);

    const none = planPlacement(M27, cpu(16));
    assert.equal(none.possible, false);
    assert.equal(none.fit, 'no');
    assert.equal(none.noReason, 'paging-short');
    assert.ok(none.wouldHelp.length >= 2, '何があれば動くかを言う');
    assert.match(none.wouldHelp[0]!, /ページングの場所.*を、あと \d+\.\dGB 増やす/);
    assert.ok(none.wouldHelp.some((h) => h.includes('GPU のある機械')));
  });

  test('64GB: 27B も 35B の MoE もメモリに載る。MoE は使う重みが少ないぶん速い', () => {
    const big = planPlacement(M27, cpu(64, { cores: 16 }), { context: 32_768, sequences: 2 });
    assert.equal(big.fit, 'slow');
    assert.equal(big.ssdBytes, 0);
    assert.equal(big.contextSize, 32_768);
    const moe = planPlacement(MOE, cpu(64, { cores: 16 }), { context: 32_768, sequences: 2 });
    assert.equal(moe.ssdBytes, 0);
    assert.ok(moe.estimatedTps > big.estimatedTps * 2, `MoE ${moe.estimatedTps} / 27B ${big.estimatedTps}`);
  });

  test('ページングの空きが分からない機械では、断らない（分からないものを「無い」と決めない）', () => {
    const p = planPlacement(M27, { ramBytes: 16 * GIB, gpus: [], cores: 8 });
    assert.equal(p.possible, true);
    assert.equal(p.fit, 'ssd');
  });
});

describe('GPU のある機械', () => {
  test('12GB VRAM + 46GB: 9B は全部を GPU に。コンテキストウィンドウを狭めてでも載せる', () => {
    const p = planPlacement(M9, windows(46, 200, 12), { context: 32_768, sequences: 2 });
    assert.equal(p.gpuLayers, 32);
    assert.equal(p.kv, 'gpu');
    assert.equal(p.fit, 'comfortable');
    assert.equal(p.ramBytes, 0);
    assert.ok(p.contextSize < 32_768 && p.contextSize >= 4096, `コンテキストウィンドウ ${p.contextSize}`);
    assert.ok(p.vramBytes <= 12 * GIB, 'VRAM を超えない');
    assert.equal(p.batchSize, 2048, '全部 GPU なら、長い入力をまとめて読む');
  });

  test('12GB VRAM + 46GB: 27B は載る層だけ GPU に、残りはメモリ。SSD は使わない', () => {
    const p = planPlacement(M27, windows(46, 200, 12), { context: 8192 });
    assert.ok(p.gpuLayers > 0 && p.gpuLayers < 64, `GPU ${p.gpuLayers}`);
    assert.equal(p.kv, 'split');
    assert.equal(p.ssdBytes, 0);
    assert.ok(p.vramBytes <= 12 * GIB - 600 * 1024 ** 2, 'VRAM の余裕を残す');
    assert.ok(p.ramBytes > 0);
    assert.equal(p.fit, 'slow');
    assert.match(describePlacement(p), /^この PC では: GPU に \d+\/64 層、残りはメモリ。目安 [\d.]+ tok\/s。遅いですが、動きます$/);
  });

  test('8GB VRAM + 16GB で 35B の MoE: GPU・メモリ・SSD の三つに分ける', () => {
    const p = planPlacement(MOE, windows(16, 200, 8), { context: 8192 });
    assert.equal(p.possible, true);
    assert.ok(p.gpuLayers > 0);
    assert.ok(p.ssdBytes > 0);
    assert.equal(p.fit, 'ssd');
    assert.match(describePlacement(p), /GPU に \d+\/40 層、残りはメモリ、足りない分（[\d.]+GB）は SSD から読みます。目安 [\d.]+ tok\/s。とても遅いですが、動きます/);
  });

  test('VRAM の空きが少ないときは、空きで数える', () => {
    const full = planPlacement(M27, windows(46, 200, 12), { context: 8192 });
    const busy = planPlacement(M27, { ...windows(46, 200, 12), gpus: [{ vramBytes: 12 * GIB, freeVramBytes: 6 * GIB }] }, { context: 8192 });
    assert.ok(busy.gpuLayers < full.gpuLayers, `${busy.gpuLayers} < ${full.gpuLayers}`);
  });

  test('GPU が二枚あれば、両方の VRAM で数える', () => {
    const one = planPlacement(M27, windows(46, 200, 12), { context: 8192 });
    const two = planPlacement(M27, { ...windows(46, 200), gpus: [{ vramBytes: 12 * GIB }, { vramBytes: 12 * GIB }] }, { context: 8192 });
    assert.ok(two.gpuLayers > one.gpuLayers);
  });
});

describe('メモリの 3 倍のモデル', () => {
  const huge: PlacementModel = { ref: 'huge.gguf', fileBytes: 48 * GIB, layers: 80, kvBytesPerToken: 327_680, trainedContext: 131_072, downloaded: true };

  test('ページングが広がる機械（Windows・空き 200GB）では、SSD から読む計画になる。メモリには固定しない', () => {
    const p = planPlacement(huge, windows(16, 200));
    assert.equal(p.possible, true);
    assert.equal(p.fit, 'ssd');
    assert.equal(p.fitLabel, 'SSD から読む（とても遅い）');
    assert.equal(p.useMmap, true);
    assert.equal(p.useMlock, false);
    assert.equal(p.ignoreMemorySafetyChecks, true, 'ライブラリの「足りない」で断らせない');
    assert.equal(p.batchSize, 256, 'メモリが苦しいときは小さく刻む');
    assert.ok(p.estimatedTps > 0, '0 tok/s は「動かない」と読まれる');
    assert.ok(p.ramBytes <= 16 * GIB - ramReserve(16 * GIB), 'メモリは空けておく分を残す');
  });

  test('システムのドライブの空きが足りなければ入らない。あといくつ空ければよいかを言う', () => {
    const p = planPlacement(huge, windows(16, 20));
    assert.equal(p.possible, false);
    assert.equal(p.noReason, 'paging-short');
    assert.match(p.wouldHelp[0]!, /システムのドライブの空きを、あと \d+\.\dGB 増やす/);
    assert.match(describePlacement(p), /^この PC では: 入りません（メモリとページングの空きを足しても届きません）。動かすには: システムのドライブの空き/);
  });

  test('重みをファイルの写しのまま使えるエンジンでは、ページングが無くても SSD から読める', () => {
    const p = planPlacement(huge, cpu(16, { weightsNeedRam: false }));
    assert.equal(p.possible, true);
    assert.equal(p.fit, 'ssd');
  });
});

describe('ディスクが小さい', () => {
  test('まだ手元に無いモデルが、保存先に置けないなら入らない', () => {
    const p = planPlacement({ ...M27, downloaded: false }, cpu(64, { modelsDiskFreeBytes: 5 * GIB }));
    assert.equal(p.possible, false);
    assert.equal(p.noReason, 'disk-full');
    assert.match(p.wouldHelp[0]!, /モデルの保存先の空きを、あと 12\.\dGB 増やす/);
    assert.match(describePlacement(p), /入りません（ディスクの空きが足りません）/);
  });

  test('もう手元に在るなら、保存先の空きは数えない（対）', () => {
    const p = planPlacement(M27, cpu(64, { modelsDiskFreeBytes: 5 * GIB }));
    assert.equal(p.possible, true);
  });

  test('一つのテンソルが、メモリとページングを足した全部より大きいと入らない', () => {
    const p = planPlacement({ ...M27, largestTensorBytes: 40 * GIB }, cpu(16, { swapBytes: 8 * GIB }));
    assert.equal(p.possible, false);
    assert.equal(p.noReason, 'tensor-too-big');
  });
});

describe('具合の言葉', () => {
  test('四つの言葉', () => {
    assert.deepEqual(FIT_LABEL, { comfortable: '快適', slow: '動く（遅い）', ssd: 'SSD から読む（とても遅い）', no: '入らない' });
  });

  test('同じ 9B でも、機械で言葉が変わる', () => {
    assert.equal(planPlacement(M9, windows(32, 200, 12)).fitLabel, '快適');
    assert.equal(planPlacement(M9, cpu(16)).fitLabel, '動く（遅い）');
    assert.equal(planPlacement(M9, windows(6, 100)).fitLabel, 'SSD から読む（とても遅い）');
    assert.equal(planPlacement(M9, cpu(6)).fitLabel, '入らない');
  });

  test('「計画を見る」に、置き方と縮めたものと待つ上限が出る', () => {
    const p = planPlacement(MOE, windows(16, 200, 8), { context: 32_768, sequences: 2 });
    const lines = placementDetail(p, MOE);
    assert.ok(lines.some((l) => /^GPU: \d+\/40 層・VRAM [\d.]+GB$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith('SSD から読む分: ') && !l.endsWith('なし')));
    assert.ok(lines.some((l) => l.startsWith('縮めたもの: コンテキストウィンドウを')));
    assert.ok(lines.some((l) => l.startsWith('待つ上限: 読み込み ')));
  });

  test('入らないときの文は、今までの「大きすぎます」に、動かす手を足す', () => {
    const m = cpu(16);
    const p = planPlacement(M27, m);
    const text = refusalText(M27.ref, p, M27, m);
    assert.match(text, /大きすぎます（15\.7GB）/);
    assert.match(text, /動かすには: /);
  });

  test('層の数が読めないモデルは、見当で数えて、見当だと言う', () => {
    const p = planPlacement({ ref: 'x.gguf', fileBytes: 20 * GIB, downloaded: true }, windows(32, 200, 8));
    assert.equal(p.layersGuessed, true);
    assert.ok(placementDetail(p, { fileBytes: 20 * GIB }).some((l) => l.includes('層の数は見当')));
  });
});

describe('待つ長さは、計画に合わせて延びる', () => {
  test('短くはしない（小さいモデルは今までの長さ）', () => {
    const p = planPlacement(M9, windows(32, 200, 12));
    assert.equal(p.timeouts.loadMs, 600_000);
    assert.equal(p.timeouts.firstTokenMs, 600_000);
    assert.equal(p.timeouts.stallMs, 120_000);
  });

  test('大きいファイルほど、読み込みを長く待つ。SSD から読む計画はさらに長い', () => {
    const inRam = planPlacement(M27, cpu(64));
    const paged = planPlacement(M27, windows(16, 200));
    const small = planPlacement(M9, cpu(64));
    assert.ok(inRam.timeouts.loadMs >= small.timeouts.loadMs);
    assert.ok(paged.timeouts.loadMs > inRam.timeouts.loadMs * 2, `${paged.timeouts.loadMs} / ${inRam.timeouts.loadMs}`);
  });

  test('遅いほど、無音を長く待つ（1 トークンに 30 秒かかるモデルを 120 秒で止めない）', () => {
    const t = timeoutsFor({ fit: 'ssd', contextSize: 4096, estimatedTps: 0.03, ssdBytes: 10 * GIB }, { fileBytes: 20 * GIB }, {});
    assert.ok(t.stallMs >= 30 / 0.03 * 1000, `無音 ${t.stallMs}`);
    assert.ok(t.firstTokenMs > 600_000 * 10, `最初の 1 トークン ${t.firstTokenMs}`);
    const fast = timeoutsFor({ fit: 'comfortable', contextSize: 4096, estimatedTps: 40, ssdBytes: 0 }, { fileBytes: 5 * GIB }, {});
    assert.equal(fast.stallMs, 120_000);
  });
});

describe('やり直しの段', () => {
  test('GPU のある機械: 計画どおり → 層を半分 → コンテキストウィンドウを下限 → GPU を使わない', () => {
    const steps = retryLadder(M27, windows(46, 200, 12), { context: 16_384, sequences: 2 });
    assert.deepEqual(steps.map((s) => s.id), ['as-planned', 'fewer-gpu-layers', 'smaller-context', 'cpu-only']);
    const [first, fewer, small, none] = steps.map((s) => s.plan);
    assert.equal(fewer!.gpuLayers, Math.floor(first!.gpuLayers / 2));
    assert.equal(small!.contextSize, 4096);
    assert.equal(small!.sequences, 1);
    assert.equal(none!.gpuLayers, 0);
    assert.match(steps[1]!.say, /GPU に載せる層を \d+ から \d+ に減らして、読み直します/);
    assert.equal(steps[3]!.say, 'GPU を使わず、メモリと SSD で読み直します');
  });

  test('GPU の無い機械では、同じ読み込みを繰り返さない', () => {
    const steps = retryLadder(M9, cpu(16), { context: 4096 });
    assert.deepEqual(steps.map((s) => s.id), ['as-planned']);
    const wider = retryLadder(M9, cpu(16), { context: 16_384, sequences: 2 });
    assert.deepEqual(wider.map((s) => s.id), ['as-planned', 'smaller-context']);
  });

  test('入らないものは、段を作らない', () => {
    assert.equal(retryLadder(M27, cpu(16)).length, 1);
  });

  test('メモリが足りずに落ちる読み込み: 段を下げて読み直し、一段ごとに一行言う', async () => {
    const steps = retryLadder(M27, windows(46, 200, 12), { context: 16_384, sequences: 2 });
    const said: string[] = [];
    const tried: string[] = [];
    // GPU に層を載せている間は、VRAM の確保で落ちる読み手
    const got = await runLadder(steps, async (step) => {
      tried.push(step.id);
      if (step.plan.gpuLayers > 0) throw new Error('cudaMalloc failed: out of memory');
      return `gpu ${step.plan.gpuLayers}`;
    }, (line) => said.push(line));
    assert.equal(got.value, 'gpu 0');
    assert.equal(got.step.id, 'cpu-only');
    assert.deepEqual(tried, ['as-planned', 'fewer-gpu-layers', 'smaller-context', 'cpu-only']);
    assert.equal(said.filter((l) => l.startsWith('やり直し ')).length, 3);
    assert.match(said.find((l) => l.startsWith('やり直し 1/3'))!, /GPU に載せる層を/);
    assert.ok(said.some((l) => l.includes('読み込めませんでした（cudaMalloc failed: out of memory）')));
  });

  test('二段目で読めたら、そこで止まる', async () => {
    const steps = retryLadder(M27, windows(46, 200, 12), { context: 16_384, sequences: 2 });
    let n = 0;
    const got = await runLadder(steps, async (step) => { n += 1; if (n === 1) throw new Error('A context size of 32768 is too large for the available VRAM'); return step.id; }, () => undefined);
    assert.equal(got.value, 'fewer-gpu-layers');
    assert.equal(n, 2);
  });

  test('メモリの失敗でないもの（壊れたファイル）は、やり直さずにそのまま投げる', async () => {
    const steps = retryLadder(M27, windows(46, 200, 12));
    let n = 0;
    await assert.rejects(runLadder(steps, async () => { n += 1; throw new Error('invalid magic characters'); }, () => undefined), /invalid magic/);
    assert.equal(n, 1);
  });

  test('どの段でも落ちたら、最後の失敗を投げる', async () => {
    const steps = retryLadder(M27, windows(46, 200, 12));
    await assert.rejects(runLadder(steps, async (s) => { throw new Error(`out of memory at ${s.id}`); }, () => undefined), /out of memory at cpu-only/);
  });

  test('メモリの失敗の見分け', () => {
    for (const text of ['InsufficientMemoryError: x', 'A context size of 8192 is too large for the available RAM', 'failed to allocate buffer', 'std::bad_alloc', 'ErrorOutOfDeviceMemory', 'Failed to create context']) {
      assert.equal(isMemoryFailure(new Error(text)), true, text);
    }
    for (const text of ['invalid magic characters', 'ENOENT: no such file', '止めています']) {
      assert.equal(isMemoryFailure(new Error(text)), false, text);
    }
  });
});

describe('試験の口と、機械の読み方', () => {
  test('AAS_TEST_RAM_BYTES で、メモリを小さく見せられる。大きくは見せない', () => {
    assert.equal(reportedRam(16 * GIB, { AAS_TEST_RAM_BYTES: String(4 * GIB) }), 4 * GIB);
    assert.equal(reportedRam(16 * GIB, { AAS_TEST_RAM_BYTES: String(64 * GIB) }), 16 * GIB);
    assert.equal(reportedRam(16 * GIB, {}), 16 * GIB);
    assert.equal(reportedRam(16 * GIB, { AAS_TEST_RAM_BYTES: 'x' }), 16 * GIB);
  });

  test('Linux の swap の空きを読む', () => {
    assert.equal(swapFreeFromMeminfo('MemTotal: 16000 kB\nSwapTotal: 4096 kB\nSwapFree:        2048 kB\n'), 2048 * 1024);
    assert.equal(swapFreeFromMeminfo('MemTotal: 16000 kB\n'), undefined);
  });
});
