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
import { install, findInstalled, listInstalled, tryRun } from '../src/runtime/llama-install.ts';
import type { Target } from '../src/runtime/llama-release.ts';
import { explainExitCode } from '../src/runtime/llama-diagnosis.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sampleZip = await readFile(join(here, 'fixtures', 'sample.zip'));

const TARGET: Target = { platform: 'linux', arch: 'x64', hasNvidia: false };

/**
 * 動くかの確かめは差し替える。
 * bundleに本物の実行ファイルを入れられないので、ここで実際に起動させると
 * 「置けたか」ではなく「作り物が動くか」を試すことになる。
 */
const runs = async () => ({ ok: true, detail: 'version b4585' });

/** リリース一覧とbundle を返す、偽の口。 */
function fakeFetch(opts: { assets?: string[]; zip?: Buffer; releaseStatus?: number; downloadStatus?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/releases/tags/')) {
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

describe('llama-server を付け替えるまで正式な場所に置かない', () => {
  test('**確かめている間は、版の名前のフォルダはまだ無い**（途中で止めても、半端な版が「用意できています」にならない）', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    let seenDuring: string | undefined;
    const r = await install({
      binDir, tag: 'b4585', target: TARGET, fetchImpl: impl,
      verify: async (command) => { seenDuring = await findInstalled(binDir, 'b4585'); assert.match(command, /\.tmp/); return runs(); },
    });
    assert.equal(seenDuring, undefined);
    assert.equal(r.command, await findInstalled(binDir, 'b4585'));
    assert.deepEqual(await listInstalled(binDir), ['b4585'], '一時フォルダが残らない');
  });

  test('**force は、新しい版が動くと確かめてから入れ替える。動かなければ前の版を残す**', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });
    const before = await findInstalled(binDir, 'b4585');
    await writeFile(before!, 'old-but-kept');
    await assert.rejects(install({
      binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, force: true,
      verify: async () => ({ ok: false, detail: 'broken' }),
    }), /動きませんでした/);
    assert.equal(await readFile(before!, 'utf8'), 'old-but-kept', '動かない版で前の版を消さない');
    assert.deepEqual(await listInstalled(binDir), ['b4585']);

    await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, force: true, verify: runs });
    assert.notEqual(await readFile((await findInstalled(binDir, 'b4585'))!, 'utf8'), 'old-but-kept', '動く版に入れ替わる');
    assert.deepEqual(await listInstalled(binDir), ['b4585'], '脇へ移した前の版が残らない');
  });

  test('**取得後の確かめは、版を言えたかで見る**（何か言っただけ・起動の失敗の文を「動く」と読まない）', async () => {
    // node --version は「v22.x」と言うが、llama-server の版の行（version: 1234）ではない
    assert.equal((await tryRun(process.execPath)).ok, false);
  });

  test('force でなければ、在る版は取りに行かない', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl, calls } = fakeFetch();
    await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });
    const n = calls.length;
    await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });
    assert.equal(calls.length, n);
  });
});

describe('llama-server の用意', () => {
  test('選んで、取ってきて、置くところまで通る', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl, calls } = fakeFetch();

    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });

    assert.equal(r.asset, 'llama-b4585-bin-ubuntu-x64.zip', '環境に合わない方を取っている');
    assert.ok(r.command.endsWith('llama-server'), r.command);
    await stat(r.command); // 実際に置かれている
    assert.ok(calls.some((c) => c.includes('/releases/tags/b4585')), '版を指定して調べていない');
  });

  test('階層は捨てて、実行ファイルと同じ場所に平らに置く', async () => {
    // 共有ライブラリは実行ファイルと同じ場所を見に行く。散らかすと動かない。
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });

    assert.equal(r.command, join(binDir, 'b4585', 'llama-server'));
    await stat(join(binDir, 'b4585', 'README.txt'));
  });

  test('実行できる状態で置く', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });

    // Windows に実行ビットは無い。動かせるかは拡張子で決まるので、
    // ここで 0o100 を求めても、実装ではなく OS の作法を試すことになる。
    // 実装側も chmod の失敗を握り潰している（意味を持たないため）。
    if (process.platform === 'win32') {
      assert.ok((await stat(r.command)).isFile(), '実行ファイルが置かれていない');
      return;
    }
    const mode = (await stat(r.command)).mode & 0o777;
    assert.ok((mode & 0o100) !== 0, `実行ビットが立っていない: ${mode.toString(8)}`);
  });

  test('すでにあれば、取りに行かない', async () => {
    const binDir = await tempDir('aas-bin-');
    await mkdir(join(binDir, 'b4585'), { recursive: true });
    await writeFile(join(binDir, 'b4585', 'llama-server'), 'ある');

    const { impl, calls } = fakeFetch();
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs });
    assert.equal(calls.length, 0, '取得済みなのに取りに行っている');
    assert.ok(r.command.endsWith('llama-server'));
  });

  test('合うものが無ければ、候補を並べて断る', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl } = fakeFetch({ assets: ['llama-b4585-bin-macos-arm64.zip'] });
    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl }),
      /合うものが見つかりません[\s\S]*macos/);
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
      fetchImpl: fakeFetch().impl, verify: runs, onProgress: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => l.includes('選びました')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('置きました')), lines.join(' / '));
  });

  test('置けても動かなければ、残さずに断る', async () => {
    const binDir = await tempDir('aas-bin-');
    await assert.rejects(
      install({
        binDir, tag: 'b4585', target: TARGET, fetchImpl: fakeFetch().impl,
        verify: async () => ({ ok: false, detail: '何も出力せず、終了コード 3221225781 で終わりました' }),
      }),
      /動きませんでした/,
    );
    // 動かない実行ファイルを置いたままにしない。次に困るのは使う人になる。
    assert.equal(await findInstalled(binDir, 'b4585'), undefined, '動かないものを残している');
  });

  test('Windows の CUDA 版には、実行時ライブラリも取ってくる', async () => {
    const binDir = await tempDir('aas-bin-');
    const { impl, calls } = fakeFetch({
      assets: ['llama-b4585-bin-win-cuda-cu12.4-x64.zip', 'cudart-llama-bin-win-cu12.4-x64.zip'],
    });
    await install({
      binDir, tag: 'b4585', fetchImpl: impl, verify: runs,
      target: { platform: 'win32', arch: 'x64', hasNvidia: true },
    });
    // 本体だけ取ってきても、Windows では起動しない。
    assert.ok(calls.some((c) => c.includes('cudart-llama-bin-win-cu12.4-x64.zip')),
      `実行時ライブラリを取りに行っていない: ${calls.join(' / ')}`);
  });
});

/** 無圧縮の zip を組む（名前をそのまま入れる。`\` 区切りの名前を作るため）。CRC は読む側が見ないので 0。 */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe('CUDA の実行時ライブラリの置き方', () => {
  test('`\\` 区切りの名前でも、入れ先のフォルダの直下に名前だけで置く', async () => {
    // Windows の join は `\` を区切りと読むので、`/` だけで切ると `..\x.dll` が入れ先のフォルダの外へ出る。
    // Linux では `\` は名前の一字なので、直下に `bin\cudart64_12.dll` という名前で置かれ、隣を見る exe からは見えない。
    const binDir = await tempDir('aas-bin-');
    const cudart = storedZip({ 'bin\\cudart64_12.dll': 'dll', '..\\..\\escaped.dll': 'bad' });
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/releases/tags/')) {
        const names = ['llama-b4585-bin-win-cuda-cu12.4-x64.zip', 'cudart-llama-bin-win-cu12.4-x64.zip'];
        return Response.json({ assets: names.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` })) });
      }
      return new Response(u.includes('cudart') ? cudart : sampleZip);
    }) as unknown as typeof fetch;
    const r = await install({
      binDir, tag: 'b4585', fetchImpl: impl, verify: runs,
      target: { platform: 'win32', arch: 'x64', hasNvidia: true },
    });
    const dest = dirname(r.command);
    assert.ok(await stat(join(dest, 'cudart64_12.dll')).catch(() => undefined), '名前だけで直下に置いていない');
    assert.ok(await stat(join(dest, 'escaped.dll')).catch(() => undefined), '`..\\` を外して直下に置いていない');
  });
});

describe('黙って落ちたときの見分け', () => {
  test('DLL が見つからない番号を、そうと言う', () => {
    assert.match(explainExitCode(3221225781), /DLL/);
    assert.match(explainExitCode(3221225781), /cudart/);
  });
  test('版が合っていない番号も見分ける', () => {
    assert.match(explainExitCode(3221225785), /版が合っていません/);
  });
  test('知らない番号には、当てずっぽうを言わない', () => {
    assert.equal(explainExitCode(1), '');
    assert.equal(explainExitCode(null), '');
  });
});

describe('.exe を置けない場所でも見つける', () => {
  test('llama-server.bin も探す', async () => {
    // 会社のクラウドドライブは名前を見て .exe を落とす（Z: で実測）。
    // 中身は同じなので、名前で動かない道具にしない。
    const { findInstalled, SERVER_NAMES } = await import('../src/runtime/llama-install.ts');
    assert.ok(SERVER_NAMES.includes('llama-server.bin'), '.bin を探していない');

    const bin = await tempDir('aas-bin-');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { PINNED_TAG } = await import('../src/runtime/llama-release.ts');
    await mkdir(join(bin, PINNED_TAG), { recursive: true });
    await writeFile(join(bin, PINNED_TAG, 'llama-server.bin'), 'x');
    assert.equal(await findInstalled(bin), join(bin, PINNED_TAG, 'llama-server.bin'));
  });
});

describe('書庫の項目名を、置く名前にする', () => {
  test('区切りは / も \\ も見る。点だけの名前は置かない', async () => {
    const { entryFileName } = await import('../src/runtime/llama-install.ts');
    assert.equal(entryFileName('bin/llama-server.exe'), 'llama-server.exe');
    assert.equal(entryFileName('a\\..\\..\\evil.dll'), 'evil.dll');
    assert.equal(entryFileName('../../evil.dll'), 'evil.dll');
    assert.equal(entryFileName('dir/..'), undefined);
    assert.equal(entryFileName('dir/'), undefined);
    // Windows は末尾の点と空白を落とすので、これらは `..` になりうる
    assert.equal(entryFileName('dir/...'), undefined);
    assert.equal(entryFileName('dir\\.. '), undefined);
    assert.equal(entryFileName('.hidden.dll'), '.hidden.dll');
  });
});

describe('取れないときの言い方', () => {
  test('合言葉が通らなければ（401）、無しで取り直す', async () => {
    const binDir = await tempDir('aas-401-');
    const seen: (string | undefined)[] = [];
    const base = fakeFetch().impl;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (String(url).includes('/releases/tags/')) {
        seen.push(auth);
        if (auth) return new Response('{"message":"Bad credentials"}', { status: 401 });
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs, token: 'ghp_broken', onProgress: (l) => lines.push(l) });
    assert.ok(r.command, '取れていない');
    assert.deepEqual(seen.map((a) => Boolean(a)), [true, false], '合言葉あり→無し の順で二度訊いていない');
    assert.ok(lines.some((l) => l.includes('無しで取り直します')));
  });

  test('一覧が断られても（403）、名前を当ててbundle を取りに行く', async () => {
    // api.github.com は塞がれていても github.com のbundle は通る回線がある（実測）。
    const binDir = await tempDir('aas-403-');
    const { impl, calls } = fakeFetch({ releaseStatus: 403 });
    const lines: string[] = [];
    const r = await install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: impl, verify: runs, onProgress: (l) => lines.push(l) });
    assert.ok(r.command);
    assert.ok(lines.some((l) => l.includes('名前を当てて')));
    assert.ok(calls.some((u) => u.includes('/releases/download/b4585/llama-b4585-bin-ubuntu-x64.zip')), calls.join('\n'));
  });

  test('bundleそのものも取れなければ、手で取る道を言う', async () => {
    const binDir = await tempDir('aas-dl404-');
    await assert.rejects(
      install({ binDir, tag: 'b4585', target: TARGET, fetchImpl: fakeFetch({ releaseStatus: 403, downloadStatus: 404 }).impl }),
      (e: Error) => e.message.includes('手で取るなら') && e.message.includes('releases/tag/b4585') && e.message.includes(binDir),
    );
  });
});

describe('置いてある llama-server を見られないとき', () => {
  test('入れ直す道（strict）では「無い」と読まずに投げる。表示の道は今までどおり「無い」', async () => {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
    const bin = await tempDir('aas-llama-unseen-');
    const target = join(bin, 'b1', 'llama-server');
    const real = fsp.stat;
    (fsp as { stat: unknown }).stat = ((p: unknown, ...rest: unknown[]) => p === target
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never;
    syncBuiltinESMExports();
    try {
      await assert.rejects(findInstalled(bin, 'b1', { strict: true }), /見られません/);
      assert.equal(await findInstalled(bin, 'b1'), undefined);
    } finally {
      (fsp as { stat: unknown }).stat = real;
      syncBuiltinESMExports();
    }
  });

  test('見られない名前があっても、ほかの名前で見つかればそれを使う（strict でも止めない）', async () => {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
    const bin = await tempDir('aas-llama-other-');
    await mkdir(join(bin, 'b1'), { recursive: true });
    await writeFile(join(bin, 'b1', 'llama-server.bin'), 'x');
    const unseen = join(bin, 'b1', 'llama-server');
    const real = fsp.stat;
    (fsp as { stat: unknown }).stat = ((p: unknown, ...rest: unknown[]) => p === unseen
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never;
    syncBuiltinESMExports();
    try {
      assert.equal(await findInstalled(bin, 'b1', { strict: true }), join(bin, 'b1', 'llama-server.bin'));
    } finally {
      (fsp as { stat: unknown }).stat = real;
      syncBuiltinESMExports();
    }
  });

  test('本当に無いときは、strict でも「無い」', async () => {
    const bin = await tempDir('aas-llama-none-');
    assert.equal(await findInstalled(bin, 'b1', { strict: true }), undefined);
  });
});
