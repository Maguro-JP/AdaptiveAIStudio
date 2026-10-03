/**
 * モデル（GGUF）を取ってくる部分の検査。
 *
 * 本物の配布元（huggingface.co）は、こちらの環境から到達できない。
 * だから**ファイル名を決め打ちにせず、一覧から選ぶ**作りにしてある。
 * ここでは一覧と中身を差し替えて、選ぶ→取る→確かめる→置く、が
 * 最後まで繋がるかと、途中で失敗したときに嘘をつかないかを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { pickModelFile, installModel, findModel, defaultModelsDir, quantFrom } from '../src/runtime/model-install.ts';
import type { CatalogEntry } from '../src/runtime/model-catalog.ts';

const ENTRY: CatalogEntry = {
  id: 'test-model', repo: 'Owner/Test-GGUF', quant: 'q4_k_m', ollama: 'test:1b',
  approxGB: 0.1, note: '検査用', license: 'Apache-2.0',
};

/** 最小の GGUF。頭さえ本物なら readGguf は読める。 */
function tinyGguf(): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => {
    const t = Buffer.from(s, 'utf8');
    return Buffer.concat([u64(t.length), t]);
  };
  parts.push(u32(0x46554747), u32(3), u64(0), u64(1));   // 目印・版・テンソル0件・KV1件
  parts.push(str('general.architecture'), u32(8), str('llama'));
  return Buffer.concat(parts);
}

function fakeFetch(opts: { files?: string[]; body?: Buffer; metaStatus?: number; fileStatus?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/models/')) {
      if (opts.metaStatus && opts.metaStatus !== 200) return new Response('x', { status: opts.metaStatus });
      const files = opts.files ?? ['README.md', 'test-q4_k_m.gguf', 'test-q8_0.gguf'];
      return Response.json({ siblings: files.map((rfilename) => ({ rfilename })) });
    }
    if (opts.fileStatus && opts.fileStatus !== 200) return new Response('x', { status: opts.fileStatus });
    const body = opts.body ?? tinyGguf();
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('ファイルの選択', () => {
  test('指定した量子化のものを選ぶ', () => {
    assert.equal(
      pickModelFile(['a-q8_0.gguf', 'a-q4_k_m.gguf', 'README.md'], 'q4_k_m'),
      'a-q4_k_m.gguf');
  });

  test('大文字小文字は問わない', () => {
    assert.equal(pickModelFile(['A-Q4_K_M.gguf'], 'q4_k_m'), 'A-Q4_K_M.gguf');
  });

  test('分割されたものは選ばない', () => {
    // 半分だけ落として「置きました」と言うのが最悪なので、そもそも選ばない
    assert.equal(
      pickModelFile(['big-q4_k_m-00001-of-00003.gguf', 'big-q4_k_m-00002-of-00003.gguf'], 'q4_k_m'),
      undefined);
  });

  test('合うものが無ければ選ばない', () => {
    assert.equal(pickModelFile(['a-q8_0.gguf'], 'q4_k_m'), undefined);
    assert.equal(pickModelFile([], 'q4_k_m'), undefined);
  });
});

describe('モデルの取得', () => {
  test('選んで、取ってきて、確かめて、置く', async () => {
    const modelsDir = await tempDir('aas-models-');
    const { impl, calls } = fakeFetch();

    const r = await installModel({ entry: ENTRY, modelsDir, fetchImpl: impl });

    assert.equal(r.file, 'test-q4_k_m.gguf');
    await stat(r.path);
    assert.ok(calls.some((c) => c.includes('/resolve/main/test-q4_k_m.gguf')), calls.join(' '));
  });

  /*
   * 進み具合は、行として流さず、状態（数字）で渡せる。
   * 1.5 秒ごとの行が記録に流れ、記録が埋まって読めなかった（実機）。
   * 画面は最新の状態だけを出せばよい。端末は今までどおり行で出る（対）。
   */
  test('onStatus を渡せば、進み具合は数字で来て、行には流れない', async () => {
    const modelsDir = await tempDir('aas-models-');
    const lines: string[] = [];
    const statuses: Array<{ pct?: number; doneBytes: number; totalBytes?: number; bytesPerSec: number }> = [];
    await installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl, onProgress: (l) => lines.push(l), onStatus: (s) => statuses.push(s) });
    assert.ok(statuses.length >= 1, '状態が一度も来ない');
    const last = statuses[statuses.length - 1]!;
    assert.equal(last.doneBytes, tinyGguf().length);
    assert.equal(last.totalBytes, tinyGguf().length);
    assert.equal(last.pct, 100);
    assert.ok(lines.every((l) => !/\d+%/.test(l)), `行にも流れている: ${lines.join(' | ')}`);
    assert.ok(lines.some((l) => l.includes('置きました')), '節目の行は残す');
  });

  test('onStatus が無ければ、今までどおり行で出る（対）', async () => {
    const modelsDir = await tempDir('aas-models-');
    const lines: string[] = [];
    await installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl, onProgress: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /\d+%/.test(l)), `行に進み具合が無い: ${lines.join(' | ')}`);
  });

  test('途中のものを残さない', async () => {
    const modelsDir = await tempDir('aas-models-');
    await installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl });
    const names = await readdir(modelsDir);
    assert.deepEqual(names, ['test-q4_k_m.gguf'], `作業用のものが残っている: ${names}`);
  });

  test('GGUF でないものを掴んだら、置かずに断る', async () => {
    // 配布元が案内のHTMLを返すことがある。中身を見ないと気づけない。
    const modelsDir = await tempDir('aas-models-');
    const html = Buffer.from('<!doctype html><title>Not found</title>');
    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch({ body: html }).impl }),
      /GGUF として読めませんでした/);
    assert.deepEqual(await readdir(modelsDir), [], '読めないものを置いている');
  });

  test('途中で切れたら、そう言って残す（続きから取るため）', async () => {
    const modelsDir = await tempDir('aas-models-');
    const short = (async (url: string | URL) => {
      if (String(url).includes('/api/models/')) {
        return Response.json({ siblings: [{ rfilename: 'test-q4_k_m.gguf' }] });
      }
      // 中身より大きい長さを申告する（途中で切れた状態）
      return new Response(tinyGguf(), { headers: { 'content-length': '99999999' } });
    }) as unknown as typeof fetch;

    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: short }), /途中で切れました/);
    // **消さない。**消すと、次もゼロから。数GBを落とす途中で切れることは
    // 普通にあるので、回線の細い家では永久に終わらなくなる。
    // 中途半端なものを「置いてある」と数えないよう、名前は .part のまま。
    // 片づけは `npm run clean` の役目。
    assert.deepEqual(await readdir(modelsDir), ['test-q4_k_m.gguf.part']);
  });

  test('分割されたものしか無ければ、扱えないと言う', async () => {
    const modelsDir = await tempDir('aas-models-');
    const { impl } = fakeFetch({ files: ['big-q4_k_m-00001-of-00003.gguf'] });
    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: impl }),
      /分割されたものは、この道具では扱えません/);
  });

  test('配布元が無ければ、名前を出して断る', async () => {
    const modelsDir = await tempDir('aas-models-');
    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch({ metaStatus: 404 }).impl }),
      /配布元が見つかりません: Owner\/Test-GGUF/);
  });

  test('すでにあれば、取りに行かない', async () => {
    const modelsDir = await tempDir('aas-models-');
    await writeFile(join(modelsDir, 'test-q4_k_m.gguf'), tinyGguf());
    const { impl, calls } = fakeFetch();
    const r = await installModel({ entry: ENTRY, modelsDir, fetchImpl: impl });
    assert.equal(calls.length, 0, '取得済みなのに取りに行っている');
    assert.ok(r.path.endsWith('test-q4_k_m.gguf'));
  });

  test('置いてあるものを見つけられる', async () => {
    const modelsDir = await tempDir('aas-models-');
    assert.equal(await findModel(modelsDir, 'q4_k_m', 'Owner/Test-GGUF'), undefined);
    await writeFile(join(modelsDir, 'test-q4_k_m.gguf'), tinyGguf());
    assert.ok(await findModel(modelsDir, 'q4_k_m', 'Owner/Test-GGUF'));
  });

  test('進み具合を黙らない', async () => {
    const modelsDir = await tempDir('aas-models-');
    const lines: string[] = [];
    await installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl, onProgress: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes('選びました')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('確かめます')), lines.join(' / '));
    assert.ok(lines.some((l) => l.includes('置きました')), lines.join(' / '));
  });
});

describe('既定の置き場', () => {
  test('利用者のホームの下に置く', () => {
    // ここが効いてくるのは Windows で利用者名が全角のとき。
    // ホーム配下である以上、既定のままだと置き場にも全角が入る。
    // だから doctor は「設定されていれば見る」ではなく、**既定も**見る必要がある。
    delete process.env.AAS_MODELS_DIR;
    delete process.env.AAS_HOME;
    // 持ち運び版の中で走らせると根が移るので、そこを固定してから見る。
    process.env.AAS_HOME = join(homedir(), '.aas');
    try {
      assert.ok(defaultModelsDir().startsWith(homedir()),
        `ホームの下でない: ${defaultModelsDir()}`);
    } finally {
      delete process.env.AAS_HOME;
    }
  });

  test('環境変数で逃がせる（全角を避けるための出口）', () => {
    process.env.AAS_MODELS_DIR = join('C:', 'ai', 'models');
    try {
      assert.equal(defaultModelsDir(), join('C:', 'ai', 'models'));
    } finally {
      delete process.env.AAS_MODELS_DIR;
    }
  });
});

describe('届かなくても、手で取る道を言う', () => {
  test('繋がらないときは、開く先と置く先を出す', async () => {
    const modelsDir = await tempDir('aas-byhand-');
    const dead = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: dead }),
      (e: Error) => e.message.includes(`https://huggingface.co/${ENTRY.repo}/tree/main`)
        && e.message.includes(ENTRY.quant)
        && e.message.includes(modelsDir),
    );
  });

  test('断られたときも、同じ道を出す', async () => {
    const modelsDir = await tempDir('aas-byhand-');
    await assert.rejects(
      installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch({ metaStatus: 403 }).impl }),
      (e: Error) => e.message.includes('手で取るなら') && e.message.includes(modelsDir),
    );
  });

  test('取れたときは、手で取る話をしない（対）', async () => {
    const modelsDir = await tempDir('aas-byhand-');
    const lines: string[] = [];
    await installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl, onProgress: (l) => lines.push(l) });
    assert.ok(!lines.some((l) => l.includes('手で取るなら')));
  });
});

describe('配布元の名前を、そのまま道にしない', () => {
  test('\\ の区切りが混ざっていても、置き場の中に置く', async () => {
    const modelsDir = await tempDir('aas-leaf-');
    const impl = fakeFetch({ files: ['sub\\..\\..\\model-q4_k_m.gguf'] }).impl;
    const r = await installModel({ entry: { ...ENTRY, quant: 'q4_k_m' }, modelsDir, fetchImpl: impl });
    assert.ok(r.path.startsWith(modelsDir), `置き場の外: ${r.path}`);
    assert.equal(r.file, 'model-q4_k_m.gguf');
  });
});

describe('数GBを、家の回線で取る', () => {
  const SIZE = 4 * 1024 * 1024;

  /** 本物と同じ形の配布元。切る・黙る・続きに応じる、を作り分ける。 */
  async function hf(plan: (round: number) => 'ok' | 'cut' | 'stall') {
    const { createServer } = await import('node:http');
    let round = 0;
    const asked: (string | undefined)[] = [];
    const srv = createServer((req, res) => {
      if (req.url?.startsWith('/api/models/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }));
      }
      round += 1;
      asked.push(req.headers.range as string | undefined);
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      const how = plan(round);
      const head = Buffer.alloc(4); head.write('GGUF');
      if (how === 'stall') { res.writeHead(200, { 'content-length': String(SIZE) }); res.write(head); return; }
      res.writeHead(from > 0 ? 206 : 200, { 'content-length': String(SIZE - from) });
      if (how === 'cut') {
        res.write(Buffer.concat([head, Buffer.alloc(SIZE / 2 - 4)]));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end(from > 0 ? Buffer.alloc(SIZE - from) : Buffer.concat([head, Buffer.alloc(SIZE - 4)]));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as import('node:net').AddressInfo;
    return {
      asked,
      fetchImpl: ((u: string | URL, init?: RequestInit) =>
        fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
      close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
    };
  }

  const entry = { id: 'x', repo: 'a/b', quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' };

  test('途中で切れても、次は続きから取る', async () => {
    // 数GBを落とす途中で切れることは普通にある。毎回ゼロからやり直させると、
    // 回線の細い家では永久に終わらない。**残骸だけが増えていた。**
    const dir = await tempDir('aas-dl-');
    const srv = await hf((n) => (n === 1 ? 'cut' : 'ok'));
    try {
      await assert.rejects(
        installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl }),
        /続きから取ります/,
        '切れたことを人の言葉で言っていない',
      );
      // 途中までが残っていること。**消すと、また最初から。**
      const part = await stat(join(dir, 'model-Q4_K_M.gguf.part'));
      assert.ok(part.size > 0, '途中までを消している');

      const done = await installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl });
      assert.equal(done.bytes, SIZE, '続きから取って、揃っていない');
      // 二度目は Range で求めていること（＝最初から取り直していない）。
      assert.match(srv.asked.at(-1) ?? '', /^bytes=\d+-$/, `続きから求めていない: ${srv.asked.at(-1)}`);
    } finally { await srv.close(); }
  });

  test('相手が黙り込んだら、打ち切る', async () => {
    // 打ち切りが無かったので、そのまま**永久に固まって**いた。画面も止まったまま。
    const dir = await tempDir('aas-dl2-');
    const srv = await hf(() => 'stall');
    const ac = new AbortController();
    // 本物の打ち切りは60秒。試験では待てないので、外から切って
    // 「切られたときに、途中までを残す」ところを見る。
    setTimeout(() => ac.abort(), 300);
    try {
      await assert.rejects(installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl, signal: ac.signal }));
      assert.ok(
        await stat(join(dir, 'model-Q4_K_M.gguf.part')).then(() => true).catch(() => false),
        '切られたときに、途中までを消している',
      );
    } finally { await srv.close(); }
  });

  test('大きさは、桁に合わせて出す', async () => {
    // 40MB を「0.0GB / 0.0GB」と出していた。何も分からない。
    const { human, mmss } = await import('../src/runtime/model-install.ts');
    assert.equal(human(4 * 1024 ** 3), '4.00GB');
    assert.equal(human(40 * 1024 ** 2), '40.0MB');
    assert.equal(human(4096), '4KB');
    assert.equal(mmss(90), '1分30秒');
    assert.equal(mmss(7200), '2時間0分');
  });
});

describe('こちらの見当が外れても、詰まないこと', () => {
  test('.gguf の URL を、そのまま渡せる', async () => {
    // 配布元の名前の付け方は変わるし、こちらがカタログに書いた見当は外れる。
    // **外れた時点で利用者が詰むのが、いちばん悪い。**
    // ブラウザで見つけた場所を、そのまま貼れること。
    const { createServer } = await import('node:http');
    const SIZE = 1024 * 1024;
    const srv = createServer((_req, res) => {
      const head = Buffer.alloc(4); head.write('GGUF');
      res.writeHead(200, { 'content-length': String(SIZE) });
      res.end(Buffer.concat([head, Buffer.alloc(SIZE - 4)]));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as import('node:net').AddressInfo;
    const dir = await tempDir('aas-url-');
    try {
      const r = await installModel({
        entry: {
          id: 'x', repo: `http://127.0.0.1:${port}/a/b/resolve/main/my-q4_k_m.gguf`,
          quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '',
        },
        modelsDir: dir,
      });
      assert.equal(r.file, 'my-q4_k_m.gguf');
      assert.deepEqual(await readdir(dir), ['my-q4_k_m.gguf']);
    } finally { srv.closeAllConnections(); await new Promise<void>((r) => { srv.close(() => r()); }); }
  });

  test('頁の URL を貼られたら、何を貼るのかを言う', async () => {
    // 「ファイルではなく頁を貼る」は必ず起きる。断るだけでは次の一手が無い。
    const dir = await tempDir('aas-url2-');
    await assert.rejects(
      installModel({
        entry: {
          id: 'x', repo: 'https://huggingface.co/a/b/tree/main',
          quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '',
        },
        modelsDir: dir,
      }),
      /ファイルそのものの場所/,
    );
  });

  test('名前が見つからないときは、探し方まで言う', async () => {
    // カタログの名前は、こちらの見当。外れたときに「見つかりません」だけでは、
    // そこで終わってしまう。
    const dir = await tempDir('aas-url3-');
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(
      installModel({
        entry: { id: 'x', repo: 'no/such', quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' },
        modelsDir: dir, fetchImpl: notFound,
      }),
      /取ってくる先/,
    );
  });
});

/**
 * 途中まで取れているものを、取り上げない。
 *
 * 数GBの取得は途中で切れる。`.part` を残して続きから取る作りにしてあるのに、
 * 二通りの形でそれを潰していた。どちらも**取り直しに何十分もかかる回線で
 * いちばん重い**。
 *
 * 1. 416（範囲外＝もう全部ある）で `open(tmp, 'w')` を通っていた。`w` は開いた
 *    時点で 0 バイトにする。**「すでに全部取れていました」と言いながら消す。**
 *    そのあと中身の確かめで落ちて、残骸まで消される。
 * 2. `content-length` を返さない相手（chunked）で `?? 0` にしていたので、
 *    `total` が `had` になり、取り切っても `written !== total` で
 *    **「途中で切れました」**と言って `.part` のまま放り出していた。
 *
 * ここは**本物の node:http サーバと素の fetch** で確かめる。
 * 作り話の `fetchImpl` だと、相手の返し方まで真似たことにならない。
 */
describe('途中まで取れているものを、取り上げない', () => {
  /** 決めた形で返す相手を立てる。 */
  async function serve(body: Buffer, how: 'range-not-satisfiable' | 'partial-no-length' | 'range-no-length') {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (how === 'range-no-length') {
        // 続きを頼まれたら長さを言わない 416。最初からなら全体を返す
        if (req.headers.range) { res.writeHead(416); return res.end(); }
        res.writeHead(200, { 'content-length': String(body.length) });
        return res.end(body);
      }
      if (how === 'range-not-satisfiable') {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` });
        return res.end();
      }
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      // 長さを言わない（chunked）。**これを返す相手が実際に居る。**
      res.writeHead(206, {
        'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
        'transfer-encoding': 'chunked',
      });
      return res.end(body.subarray(from));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  /** URL を直に渡す形。カタログを引かずに、取る所だけを通す。 */
  const direct = (port: number) => ({
    ...ENTRY, repo: `http://127.0.0.1:${port}/probe-model.gguf`,
  });

  test('**416 のとき、取れているものを 0 バイトにしない**', async () => {
    const body = tinyGguf();
    const modelsDir = await tempDir('aas-dl416-');
    // すでに全部取れている `.part`。
    await writeFile(join(modelsDir, 'probe-model.gguf.part'), body);
    const s = await serve(body, 'range-not-satisfiable');
    try {
      const got = await installModel({ entry: direct(s.port), modelsDir });
      assert.equal(got.bytes, body.length, `大きさが合わない: ${got.bytes}`);
      assert.deepEqual((await readdir(modelsDir)).sort(), ['probe-model.gguf'],
        '取れていたものを失っている');
      assert.equal((await stat(got.path)).size, body.length);
    } finally { await s.close(); }
  });

  test('**416 が本当の長さを言わないなら、途中までのものを置かず、最初から取り直す**', async () => {
    // 見出しの無い 416 を「全部ある」と読み、途中までのファイルを正式な名前にしていた。
    // 止めるだけでは、次も同じ 416 で止まり、手で .part を消すまで抜けられない
    const body = tinyGguf();
    const modelsDir = await tempDir('aas-dl416-nolen-');
    await writeFile(join(modelsDir, 'probe-model.gguf.part'), body.subarray(0, Math.floor(body.length / 2)));
    const s = await serve(body, 'range-no-length');
    try {
      const got = await installModel({ entry: direct(s.port), modelsDir });
      assert.equal((await stat(got.path)).size, body.length, '途中までのものを置いた');
      assert.deepEqual((await readdir(modelsDir)).sort(), ['probe-model.gguf']);
    } finally { await s.close(); }
  });

  test('**長さを言わない相手でも、取り切ったら置く**', async () => {
    const body = tinyGguf();
    const modelsDir = await tempDir('aas-dl206-');
    // 半分まで取れているところから続ける。
    await writeFile(join(modelsDir, 'probe-model.gguf.part'), body.subarray(0, Math.floor(body.length / 2)));
    const s = await serve(body, 'partial-no-length');
    try {
      const got = await installModel({ entry: direct(s.port), modelsDir });
      assert.equal(got.bytes, body.length, `途中で切れたことにしている: ${got.bytes}`);
      assert.deepEqual((await readdir(modelsDir)).sort(), ['probe-model.gguf'], '.part のまま放り出している');
    } finally { await s.close(); }
  });
});

describe('途中まで取ったファイルを見られないとき', () => {
  test('空にしてゼロから取り直さず、そう言って残す', async () => {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const require = createRequire(import.meta.url);
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const modelsDir = await tempDir('aas-models-part-');
    const part = join(modelsDir, 'test-q4_k_m.gguf.part');
    await writeFile(part, 'x'.repeat(1000));
    const real = fsp.stat;
    // 見られなさは、その道だけ stat を失敗させて作る（権限に頼らない）
    (fsp as { stat: unknown }).stat = ((p: unknown, ...rest: unknown[]) => p === part
      ? Promise.reject(Object.assign(new Error('resource busy or locked, stat (長い英文)'), { code: 'EBUSY' }))
      : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never;
    syncBuiltinESMExports();
    try {
      // 理由は符丁で言う（stat の長い英文をそのまま出さない）
      await assert.rejects(installModel({ entry: ENTRY, modelsDir, fetchImpl: fakeFetch().impl }), /見られません（EBUSY）/);
    } finally {
      (fsp as { stat: unknown }).stat = real;
      syncBuiltinESMExports();
    }
    assert.equal((await stat(part)).size, 1000, '取れていた分を空にした');
  });
});

describe('置いてあるかを、名前の語で見る', () => {
  test('名前の一部が重なる別のモデルを「もうある」としない', async () => {
    const modelsDir = await tempDir('aas-findmodel-');
    await writeFile(join(modelsDir, 'Qwen3.5-4B-Q4_K_M.gguf'), 'GGUF');
    await writeFile(join(modelsDir, 'Qwen3-14B-Q4_K_M.gguf'), 'GGUF');
    assert.equal(await findModel(modelsDir, 'q4_k_m', 'unsloth/Qwen3-4B-GGUF'), undefined);
    await writeFile(join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'), 'GGUF');
    assert.equal(await findModel(modelsDir, 'q4_k_m', 'unsloth/Qwen3-4B-GGUF'), join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'));
    assert.equal(await findModel(modelsDir, 'q4_k_m', 'unsloth/Qwen3.5-4B-GGUF'), join(modelsDir, 'Qwen3.5-4B-Q4_K_M.gguf'));
  });

  test('量子化の名前が . で繋がったファイルも見つける（取り直さない）', async () => {
    const modelsDir = await tempDir('aas-findmodel-dot-');
    await writeFile(join(modelsDir, 'mistral-7b-instruct-v0.2.Q4_K_M.gguf'), 'GGUF');
    assert.equal(await findModel(modelsDir, 'q4_k_m', 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF'),
      join(modelsDir, 'mistral-7b-instruct-v0.2.Q4_K_M.gguf'));
  });
});

describe('命令行の --quant', () => {
  test('無ければ q4_k_m（node の場所を量子化の名前として読まない）', () => {
    assert.equal(quantFrom(['/usr/bin/node', 'models.ts', '--get', 'a/b']), 'q4_k_m');
    assert.equal(quantFrom(['node', 'models.ts', '--get', 'a/b', '--quant', 'q8_0']), 'q8_0');
    assert.equal(quantFrom(['node', 'models.ts', '--quant', '--get', 'a/b']), 'q4_k_m');
  });
});

describe('URL を直に渡したとき', () => {
  test('同じ名前が置いてあれば取りに行かない（数GBを取り直して上書きしない）', async () => {
    const modelsDir = await tempDir('aas-direct-have-');
    await writeFile(join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'), 'GGUF');
    let asked = 0;
    const impl = (async () => { asked++; throw new Error('取りに行った'); }) as unknown as typeof fetch;
    for (const repo of [
      'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
      'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true',
    ]) {
      const r = await installModel({
        entry: { id: repo, repo, quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' },
        modelsDir, fetchImpl: impl,
      });
      assert.equal(r.path, join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'));
    }
    assert.equal(asked, 0, '置いてあるのに取りに行った');
  });

  test('名前に %2F・%5C が入っていても、フォルダの外へ書かない', async () => {
    // URL の段階では %2F は区切りでないので一つの名前として残り、decode した後で ../ になっていた
    const outer = await tempDir('aas-direct-escape-');
    const modelsDir = join(outer, 'a', 'models');
    await (await import('node:fs/promises')).mkdir(modelsDir, { recursive: true });
    let asked = 0;
    const impl = (async () => { asked++; throw new Error('取りに行った'); }) as unknown as typeof fetch;
    for (const repo of [
      'https://host.invalid/m/..%2F..%2Fx.gguf',
      'https://host.invalid/m/..%5C..%5Cx.gguf',
      'https://host.invalid/m/C%3Ax.gguf',
      // Windows で使えない字と予約名
      'https://host.invalid/m/a%3Fb.gguf',
      'https://host.invalid/m/a%7Cb.gguf',
      'https://host.invalid/m/NUL.gguf',
      'https://host.invalid/m/con.gguf',
    ]) {
      await assert.rejects(
        installModel({ entry: { id: repo, repo, quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' }, modelsDir, fetchImpl: impl }),
        /区切り/, repo);
    }
    assert.equal(asked, 0, '外を指す名前のまま取りに行った');
    // 普通の名前（空白入り・console で始まる）は断らない（対）
    for (const repo of ['https://host.invalid/m/My%20Model.gguf', 'https://host.invalid/m/console-1b.gguf']) {
      await assert.rejects(
        installModel({ entry: { id: repo, repo, quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' }, modelsDir, fetchImpl: impl }),
        /取りに行った/, `${repo} を名前で断っている`);
    }
    // フォルダの外（二つ上まで）に何も作っていない
    assert.deepEqual((await readdir(outer)).sort(), ['a']);
    assert.deepEqual((await readdir(join(outer, 'a'))).sort(), ['models']);
  });
});

describe('続きから取るとき、別の版を継がない', () => {
  const entry = { id: 'x', repo: 'a/b', quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '' };
  const body = (fill: number) => Buffer.concat([tinyGguf(), Buffer.alloc(64 * 1024, fill)]);

  /** 今の版は `now`。Range と If-Range に、本物の配布元と同じ決まりで応じる。`answer` で続きの返し方を変えられる。 */
  async function origin(now: Buffer, etag: string, answer?: 'wrongStart' | 'ignoreIfRange') {
    const { createServer } = await import('node:http');
    const asked: { range?: string; ifRange?: string }[] = [];
    const srv = createServer((req, res) => {
      if (req.url?.startsWith('/api/models/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }));
      }
      const range = req.headers.range as string | undefined;
      const ifRange = req.headers['if-range'] as string | undefined;
      asked.push({ range, ifRange });
      const from = Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? NaN);
      // If-Range が今の版と違えば、範囲を無視して全体を返す（RFC 9110）
      if (range === undefined || (answer !== 'ignoreIfRange' && ifRange !== undefined && ifRange !== etag)) {
        res.writeHead(200, { 'content-length': String(now.length), etag });
        return res.end(now);
      }
      if (from >= now.length) {
        res.writeHead(416, { 'content-range': `bytes */${now.length}` });
        return res.end();
      }
      if (answer === 'wrongStart') {
        // 範囲を無視して頭から返してくる相手
        res.writeHead(206, { 'content-length': String(now.length), 'content-range': `bytes 0-${now.length - 1}/${now.length}`, etag });
        return res.end(now);
      }
      const rest = now.subarray(from);
      res.writeHead(206, { 'content-length': String(rest.length), 'content-range': `bytes ${from}-${now.length - 1}/${now.length}`, etag });
      res.end(rest);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as import('node:net').AddressInfo;
    return {
      asked,
      fetchImpl: ((u: string | URL, init?: RequestInit) =>
        fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
      close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
    };
  }

  test('途中で配布元の版が変わったら、古い頭に新しい続きを継がずに取り直す', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-dl-ifrange-');
    const older = body(0x61);
    const newer = body(0x62);
    // 前の版を半分まで取ってあった
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part'), older.subarray(0, older.length / 2));
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part.tag'), '"v1"');
    const srv = await origin(newer, '"v2"');
    try {
      const got = await installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl });
      assert.ok((await readFile(got.path)).equals(newer), '古い頭に新しい続きを継いだ');
      assert.equal(srv.asked[0]?.ifRange, '"v1"', `続きを頼むときに版を添えていない: ${JSON.stringify(srv.asked)}`);
      await assert.rejects(stat(join(dir, 'model-Q4_K_M.gguf.part.tag')), '取り終えたのに版の記録が残っている');
    } finally { await srv.close(); }
  });

  test('If-Range を無視して別の版の続きを返されても、継がずに取り直す', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-dl-ignore-');
    const older = body(0x66);
    const newer = body(0x67);
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part'), older.subarray(0, older.length / 2));
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part.tag'), '"v5"');
    const srv = await origin(newer, '"v6"', 'ignoreIfRange');
    try {
      const got = await installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl });
      assert.ok((await readFile(got.path)).equals(newer), '別の版の続きを継いだ');
    } finally { await srv.close(); }
  });

  test('416 で配布元の長さが手元と違えば、「全部取れている」としない', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-dl-416-');
    const now = body(0x63);
    // 前の版の残り。今の版より長い
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part'), Buffer.concat([now, Buffer.alloc(1024, 0x64)]));
    const srv = await origin(now, '"v3"');
    try {
      const got = await installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl });
      assert.ok((await readFile(got.path)).equals(now), `長さの違う残りを置いた（${(await readFile(got.path)).length} / ${now.length}）`);
    } finally { await srv.close(); }
  });

  test('続きの始まりが手元の長さと違えば、継がずに取り直す', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-dl-start-');
    const now = body(0x65);
    await writeFile(join(dir, 'model-Q4_K_M.gguf.part'), now.subarray(0, 1000));
    const srv = await origin(now, '"v4"', 'wrongStart');
    try {
      const got = await installModel({ entry, modelsDir: dir, fetchImpl: srv.fetchImpl });
      assert.ok((await readFile(got.path)).equals(now), '頭から返ってきた分を、続きとして継いだ');
    } finally { await srv.close(); }
  });
});
