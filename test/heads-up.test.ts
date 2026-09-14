/**
 * 開いた時点で、どれをどれだけ待って読むかを言う。
 *
 * GPU の無い機械で 8B を読んでいたとき、最初の答えに何分もかかった。
 * その間、画面には「待機中」しか無く、送った人には無視されたようにしか
 * 見えなかった。**送る前に言う。**読み込みは始めない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { headsUp, HEAVY_ON_CPU_BYTES } from '../src/runtime/inproc.ts';

const GB = 1024 ** 3;
const RAM = 16 * GB;
const big = { ref: 'big-8b.gguf', sizeBytes: 5 * GB };
const small = { ref: 'small-1b.gguf', sizeBytes: 0.8 * GB };

describe('先の一言', () => {
  test('GPU なしで大きいものを読むなら、待つことと小さい方を言う', () => {
    const s = headsUp([big, small], RAM, 'big-8b.gguf', { hasGpu: false });
    assert.ok(s, '何も言っていない');
    assert.match(s, /big-8b\.gguf（5\.0GB）/);
    assert.match(s, /数分/);
    assert.match(s, /small-1b\.gguf（819MB）/, '1GB 未満は MB で言う');
  });

  test('小さい方が無ければ、待つことだけ言う', () => {
    const s = headsUp([big], RAM, undefined, { hasGpu: false });
    assert.ok(s);
    assert.ok(!s.includes('小さいものもあります'));
  });

  test('GPU で読み、VRAM に丸ごと載るなら、何も言わない', () => {
    assert.equal(headsUp([big, small], RAM, 'big-8b.gguf', { hasGpu: true, vramBytes: 8 * GB }), undefined);
  });

  test('GPU で読むが VRAM が分からないなら、何も言わない（対）', () => {
    assert.equal(headsUp([big, small], RAM, 'big-8b.gguf', { hasGpu: true }), undefined);
  });

  /*
   * **VRAM を数えずに「GPU があるから大きい方」を選んでいた。**
   * 8GB の GPU に 20GB を選び、載らない分が CPU に溢れて答えなかった（実機）。
   * 載り切らないものを読むなら、遅くなることと、載るものが在ることを言う。
   */
  test('GPU で読むが VRAM に丸ごと載らないなら、遅くなることと、載るものを言う', () => {
    const huge = { ref: 'huge-35b.gguf', sizeBytes: 20 * GB };
    const s = headsUp([huge, big, small], 32 * GB, 'huge-35b.gguf', { hasGpu: true, vramBytes: 8 * GB });
    assert.ok(s, '何も言っていない');
    assert.match(s, /huge-35b\.gguf（20\.0GB）は VRAM（8\.0GB）に丸ごとは載りません/);
    assert.match(s, /遅くなります/);
    // 載るもののうち、いちばん大きいものを勧める（small ではなく big）。
    assert.match(s, /VRAM に丸ごと載るものもあります: big-8b\.gguf（5\.0GB）/);
  });

  test('VRAM に載るものが他に無ければ、遅くなることだけ言う', () => {
    const huge = { ref: 'huge-35b.gguf', sizeBytes: 20 * GB };
    const s = headsUp([huge], 32 * GB, undefined, { hasGpu: true, vramBytes: 8 * GB });
    assert.ok(s);
    assert.ok(!s.includes('載るものもあります'), s);
  });

  /*
   * **GPU が見えているのに、読む側が使えていない。**大きさに関わらず言う。
   * 黙っていると、遅い理由を機械の性能に探すことになる（実機で、そう探した）。
   */
  test('GPU が見えているのに読む側が使えていないなら、小さいものでもそう言う', () => {
    const s = headsUp([small], RAM, undefined, { hasGpu: false, seenGpu: 'NVIDIA GeForce RTX 4060' });
    assert.ok(s, '何も言っていない');
    assert.match(s, /GPU（NVIDIA GeForce RTX 4060）は見えていますが、読む側が使えていません/);
  });

  test('GPU が見えていなくて小さいなら、何も言わない（対）', () => {
    assert.equal(headsUp([small], RAM, undefined, { hasGpu: false }), undefined);
  });

  test('設定が無ければ小さい方が選ばれるので、何も言わない（対）', () => {
    // GPU なしの自動選択は小さい方。待たされないなら、脅さない。
    assert.equal(headsUp([big, small], RAM, undefined, { hasGpu: false }), undefined);
  });

  test('線より小さいものは、何も言わない', () => {
    assert.equal(headsUp([{ ref: 'a.gguf', sizeBytes: HEAVY_ON_CPU_BYTES - 1 }], RAM, undefined, { hasGpu: false }), undefined);
  });

  test('載らないものは、ここでは言わない（そちらは別の口が断る）', () => {
    assert.equal(headsUp([{ ref: 'huge.gguf', sizeBytes: 40 * GB }], RAM, undefined, { hasGpu: false }), undefined);
  });
});
