/**
 * llama-server を自前で用意する部分の検査。
 *
 * 本物を取りに行くと、検査がネットワークと数百MBに縛られる。
 * ここでは取得の口を差し替え、**本物の zip 構造**（python が作った検査用のもの）を
 * 返させて、選ぶ→取る→展開する→置く、が最後まで繋がるかを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDir } from './tmp.ts';
import { install, findInstalled, listInstalled } from '../src/runtime/llama-install.ts';
import type { Target } from '../src/runtime/llama-release.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sampleZip = await readFile(join(here, 'fixtures', 'sample.zip'));

const TARGET: Target = { platform: 'linux', arch: 'x64', hasNvidia: false };

/** リリース一覧と配布物を返す、偽の口。 */
function fakeFetch(opts: { assets?: string[]; zip?: Buffer; releaseStatus?: number; downloadStatus?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/releases/')) {
      if (opts.releaseStatus && opts.releaseStatus !== 200) {
        return new Response('no', { status: opts.releaseStatus });
      }
      const names = opts.assets ?? ['llama-b4585-bin-ubuntu-x64.zip', 'llama-b4585-bin-win-avx2-x64.zip'];
      return Response.json({
        assets: names.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` })),
      });
    }
    if (opts.downloadStatus && opts.downloadStatus !== 200) {
      return new Response('no', { status: opts.downloadStatus });
    }
    return new Response(opts.zip ?? sampleZip);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('llama-server の用意', () => {
  test('選んで、取ってきて、置くところまで通る', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl, calls } = fakeFetch();

    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl });

    assert.equal(r.asset, 'llama-b4585-bin-ubuntu-x64.zip', '環境に合わない方を取っている');
    assert.ok(r.command.endsWith('llama-server'), r.command);
    await stat(r.command); // 実際に置かれている
    assert.ok(calls.some((c) => c.includes('/releases/tags/b4585')), '版を指定して調べていない');
  });

  test('階層は捨てて、実行ファイルと同じ場所に平らに置く', async () => {
    // 共有ライブラリは実行ファイルと同じ場所を見に行く。散らかすと動かない。
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl });

    assert.equal(r.command, join(binDir, 'b4585', 'llama-server'));
    await stat(join(binDir, 'b4585', 'README.txt'));
  });

  test('実行できる状態で置く', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl });
    const mode = (await stat(r.command)).mode & 0o777;
    assert.ok((mode & 0o100) !== 0, `実行ビットが立っていない: ${mode.toString(8)}`);
  });

  test('すでにあれば、取りに行かない', async () => {
    const binDir = await tempDir('aas-bin-');
    await mkdir(join(binDir, 'b4585'), { recursive: true });
    await writeFile(join(binDir, 'b4585', 'llama-server'), 'ある');

    const { impl, calls } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl });
    assert.equal(calls.length, 0, '取得済みなのに取りに行っている');
    assert.ok(r.command.endsWith('llama-server'));
  });

  test('合う配布物が無ければ、候補を並べて断る', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch({ assets: ['llama-b4585-bin-macos-arm64.zip'] });
    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl }),
      /合う配布物が見つかりません[\s\S]*macos/);
  });

  test('中身に llama-server が無ければ、置かずに断る', async () => {
    const binDir = await tempDir('aas-bin-');
    // llama-server を含まない zip（README だけ）を作って返す
    const noServer = await readFile(join(here, 'fixtures', 'no-server.zip'));
    const { impl } = fakeFetch({ zip: noServer });

    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl }),
      /llama-server が入っていません/);
    // 中途半端に置かれたものが残っていないこと
    assert.equal(await findInstalled(binDir, 'b4585'), undefined, '半分だけ置かれたものが残っている');
    assert.deepEqual(await listInstalled(binDir), [], '空の置き場が残っている');
  });

  test('取りに行けなければ、理由を言う', async () => {
    const binDir = await tempDir('aas-bin-');
    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: fakeFetch({ releaseStatus: 404 }).impl }),
      /リリースを調べられませんでした \(404\)/);
    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: fakeFetch({ downloadStatus: 500 }).impl }),
      /取ってこられませんでした \(500\)/);
  });

  test('進み具合を黙らない', async () => {
    const binDir = await tempDir('aas-bin-');
    const lines: string[] = [];
    await install({
      binDir, tag: 'b4585', target: TARGET,
      fetchImpl: fakeFetch().impl, onProgress: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => l.includes('選びました')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('置きました')), lines.join(' / '));
  });
});
