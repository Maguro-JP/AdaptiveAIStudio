/**
 * この機械に合う配布物を選べるか。
 *
 * 配布物の名前は版によって揺れる。実際に出回っている名前を並べて、
 * 「揺れても選べること」と「絶対に選んではいけないものを選ばないこと」を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickAsset, type Target } from '../src/runtime/llama-release.ts';

/** ある版のリリースに並んでいた名前の一式（形は実物に合わせてある）。 */
const ASSETS = [
  'llama-b4585-bin-win-avx-x64.zip',
  'llama-b4585-bin-win-avx2-x64.zip',
  'llama-b4585-bin-win-avx512-x64.zip',
  'llama-b4585-bin-win-cuda-cu11.7-x64.zip',
  'llama-b4585-bin-win-cuda-cu12.4-x64.zip',
  'llama-b4585-bin-win-hip-x64.zip',
  'llama-b4585-bin-win-sycl-x64.zip',
  'llama-b4585-bin-win-vulkan-x64.zip',
  'llama-b4585-bin-win-arm64.zip',
  'llama-b4585-bin-ubuntu-x64.zip',
  'llama-b4585-bin-ubuntu-cuda-x64.zip',
  'llama-b4585-bin-ubuntu-vulkan-x64.zip',
  'llama-b4585-bin-macos-arm64.zip',
  'llama-b4585-bin-macos-x64.zip',
  'cudart-llama-bin-win-cu12.4-x64.zip',
  'llama-b4585-src.tar.gz',
];

const target = (over: Partial<Target> = {}): Target => ({
  platform: 'win32', arch: 'x64', hasNvidia: false, ...over,
});

describe('配布物の選択', () => {
  test('Windows・NVIDIA あり → CUDA 版', () => {
    const c = pickAsset(ASSETS, target({ hasNvidia: true }));
    assert.equal(c?.name, 'llama-b4585-bin-win-cuda-cu12.4-x64.zip');
    assert.match(c?.why ?? '', /CUDA/);
  });

  test('CUDA が複数あれば、新しい方を採る', () => {
    // cu11.7 と cu12.4 が並んでいる。古い方を掴むと、動くのに遅い。
    const c = pickAsset(ASSETS, target({ hasNvidia: true }));
    assert.ok(!c?.name.includes('cu11'), `古い方を選んでいる: ${c?.name}`);
  });

  test('Windows・NVIDIA なし → CPU 版（AVX2）', () => {
    const c = pickAsset(ASSETS, target());
    assert.equal(c?.name, 'llama-b4585-bin-win-avx2-x64.zip');
  });

  test('NVIDIA が無いのに CUDA 版を選ばない', () => {
    const c = pickAsset(ASSETS, target());
    assert.ok(!c?.name.includes('cuda'), `動かないものを選んでいる: ${c?.name}`);
  });

  test('他社の GPU 向けを間違って選ばない', () => {
    const c = pickAsset(ASSETS, target({ hasNvidia: true }));
    for (const wrong of ['hip', 'sycl', 'vulkan']) {
      assert.ok(!c?.name.includes(wrong), `${wrong} 版を選んでいる: ${c?.name}`);
    }
  });

  test('Windows ARM は ARM 版', () => {
    const c = pickAsset(ASSETS, target({ arch: 'arm64' }));
    assert.equal(c?.name, 'llama-b4585-bin-win-arm64.zip');
  });

  test('macOS は Apple Silicon と Intel を取り違えない', () => {
    assert.equal(
      pickAsset(ASSETS, target({ platform: 'darwin', arch: 'arm64' }))?.name,
      'llama-b4585-bin-macos-arm64.zip');
    assert.equal(
      pickAsset(ASSETS, target({ platform: 'darwin', arch: 'x64' }))?.name,
      'llama-b4585-bin-macos-x64.zip');
  });

  test('Linux も NVIDIA の有無で分かれる', () => {
    assert.equal(
      pickAsset(ASSETS, target({ platform: 'linux', hasNvidia: true }))?.name,
      'llama-b4585-bin-ubuntu-cuda-x64.zip');
    assert.equal(
      pickAsset(ASSETS, target({ platform: 'linux' }))?.name,
      'llama-b4585-bin-ubuntu-x64.zip');
  });

  test('名前が揺れても選べる', () => {
    // 版が変われば名前も変わる。決め打ちにしていないことの確認。
    const future = [
      'llama-b9999-bin-win-cuda-cu13.0-x64.zip',
      'llama-b9999-bin-win-avx2-x64.zip',
      'llama-b9999-bin-ubuntu-x64.zip',
    ];
    assert.equal(
      pickAsset(future, target({ hasNvidia: true }))?.name,
      'llama-b9999-bin-win-cuda-cu13.0-x64.zip');
  });

  test('中身のある候補が無ければ、選ばない', () => {
    assert.equal(pickAsset(['llama-src.tar.gz'], target({ platform: 'darwin', arch: 'arm64' })), undefined);
    assert.equal(pickAsset([], target()), undefined);
  });

  test('ソース配布や別物を掴まない', () => {
    // cudart-*.zip は CUDA の実行時ライブラリだけで、llama-server は入っていない。
    // 名前に cuda を含むので、当てはめだけでは弾けない。
    // 並び順の運で外れていないことを確かめるため、これ1つだけを候補にして試す。
    assert.equal(pickAsset(['cudart-llama-bin-win-cu12.4-x64.zip'], target({ hasNvidia: true })), undefined);
    const c = pickAsset(ASSETS, target({ hasNvidia: true }));
    assert.ok(!c?.name.startsWith('cudart'), `別物を掴んでいる: ${c?.name}`);
  });
});
