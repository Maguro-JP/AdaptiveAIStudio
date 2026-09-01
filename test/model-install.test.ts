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
import { pickModelFile, installModel, findModel, defaultModelsDir } from '../src/runtime/model-install.ts';
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

  test('途中で切れたら、そう言って残さない', async () => {
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
    assert.deepEqual(await readdir(modelsDir), []);
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
