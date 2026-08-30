import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, truncate } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { readGguf, quantName, BadFormatError, TruncatedError } from '../src/runtime/gguf.ts';
import { extractFacts, toModelSpec, dominantQuant, bitsFor, formatGguf,
} from '../src/runtime/gguf-spec.ts';

/**
 * ここで作るのは「仕様の理解どおりに書いた GGUF」であって、本物ではない。
 * つまりこの試験が通っても、**理解が正しいことの証明にはならない**。
 * 証明できるのは「読み取りと書き出しが噛み合っていること」と、
 * 「壊れたものを渡したときに壊れ方が穏やかであること」の二つ。
 *
 * 本物での確認は `npm run models -- --inspect <ファイル>` で人がやる。
 */
class GgufWriter {
  #parts: Uint8Array[] = [];

  #push(bytes: Uint8Array): void { this.#parts.push(bytes); }
  u32(v: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.#push(b); return this; }
  u64(v: number): this { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.#push(b); return this; }
  u8(v: number): this { this.#push(new Uint8Array([v])); return this; }
  f32(v: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.#push(b); return this; }
  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    this.u64(bytes.length);
    this.#push(bytes);
    return this;
  }
  bytes(): Uint8Array {
    const total = this.#parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.#parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }
}

type Kv = [string, number, unknown];

interface BuildOpts {
  kvs: Kv[];
  tensors?: Array<{ name: string; dims: number[]; typeId: number }>;
  magic?: number;
  version?: number;
  /** 見かけの大きさ。中身は作らず、末尾の位置だけを動かす。 */
  padTo?: number;
}

function build(opts: BuildOpts): Uint8Array {
  const w = new GgufWriter();
  w.u32(opts.magic ?? 0x46554747);
  w.u32(opts.version ?? 3);
  w.u64(opts.tensors?.length ?? 0);
  w.u64(opts.kvs.length);

  for (const [key, type, value] of opts.kvs) {
    w.str(key);
    w.u32(type);
    if (type === 8) w.str(value as string);
    else if (type === 4) w.u32(value as number);
    else if (type === 10) w.u64(value as number);
    else if (type === 6) w.f32(value as number);
    else if (type === 7) w.u8((value as boolean) ? 1 : 0);
    else if (type === 9) {
      const arr = value as { elemType: number; items: unknown[] };
      w.u32(arr.elemType);
      w.u64(arr.items.length);
      for (const item of arr.items) {
        if (arr.elemType === 8) w.str(item as string);
        else w.u32(item as number);
      }
    } else if (type === 99) {
      // 知らない型を書く（読み手が困る形を作るため）
      w.u32(0);
    }
  }

  for (const t of opts.tensors ?? []) {
    w.str(t.name);
    w.u32(t.dims.length);
    for (const d of t.dims) w.u64(d);
    w.u32(t.typeId);
    w.u64(0);
  }

  return w.bytes();
}

/**
 * 仮の GGUF を置く。
 *
 * `padTo` は「見かけの大きさ」。中身は作らず、末尾の位置だけを動かす。
 * 読む側は頭だけを読み、大きさは stat で見るので、これで足りる。
 * 4GB の 0 を本当に書くと、Windows では書き込みと走査で数分かかり、
 * 並列で走る試験どうしがメモリとディスクを食い合って落ちる。
 */
async function writeTmp(source: Uint8Array | BuildOpts, name = 'model.gguf'): Promise<string> {
  const bytes = source instanceof Uint8Array ? source : build(source);
  const padTo = source instanceof Uint8Array ? undefined : source.padTo;

  const dir = await tempDir('aas-gguf-');
  const path = join(dir, name);
  await writeFile(path, bytes);
  if (padTo && padTo > bytes.byteLength) await truncate(path, padTo);
  return path;
}

/** ごく普通の 7B 相当。 */
const NORMAL: Kv[] = [
  ['general.architecture', 8, 'llama'],
  ['general.name', 8, 'Test Llama 7B'],
  ['llama.block_count', 4, 32],
  ['llama.embedding_length', 4, 4096],
  ['llama.context_length', 4, 8192],
  ['llama.attention.head_count', 4, 32],
  ['llama.attention.head_count_kv', 4, 8],
  ['tokenizer.ggml.tokens', 9, { elemType: 8, items: ['a', 'b', 'c'] }],
];

const BIG_TENSORS = [
  { name: 'blk.0.attn_q.weight', dims: [4096, 4096], typeId: 12 },
  { name: 'blk.0.ffn_gate.weight', dims: [4096, 11008], typeId: 12 },
  { name: 'blk.0.attn_norm.weight', dims: [4096], typeId: 0 },
];

describe('読み取り', () => {
  test('書いてあることをそのまま返す', async () => {
    const path = await writeTmp({ kvs: NORMAL, tensors: BIG_TENSORS });
    const file = await readGguf(path);
    assert.equal(file.version, 3);
    assert.equal(file.metadata.get('general.architecture'), 'llama');
    assert.equal(file.metadata.get('llama.block_count'), 32);
    assert.equal(file.tensors.length, 3);
    assert.deepEqual(file.warnings, []);
  });

  test('GGUF でないものは、そう言って断る', async () => {
    const path = await writeTmp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await assert.rejects(() => readGguf(path), BadFormatError);
  });

  test('途中で切れているファイルでも、投げずに読めたところまで返す', async () => {
    const full = build({ kvs: NORMAL, tensors: BIG_TENSORS });
    const path = await writeTmp(full.subarray(0, 60));
    const file = await readGguf(path);
    assert.ok(file.warnings.length > 0, '黙って捨てている');
    assert.ok(file.metadata.size < NORMAL.length);
  });

  test('知らない型に出会ったら、そこで止めて理由を残す', async () => {
    const path = await writeTmp({
      kvs: [['general.architecture', 8, 'llama'], ['変な項目', 99, 0], ['llama.block_count', 4, 32]],
    });
    const file = await readGguf(path);
    assert.equal(file.metadata.get('general.architecture'), 'llama');
    assert.equal(file.metadata.has('llama.block_count'), false, '位置がずれたまま読み進めている');
    assert.ok(file.warnings.some((w) => w.includes('変な項目')));
  });

  test('数が異常な値でメモリを食い潰さない', async () => {
    const w = new GgufWriter();
    w.u32(0x46554747).u32(3).u64(0).u64(999_999_999_999);
    const path = await writeTmp(w.bytes());
    await assert.rejects(() => readGguf(path), BadFormatError);
  });

  test('知らない版でも、読めるところまで読む', async () => {
    const path = await writeTmp({ kvs: NORMAL, version: 99 });
    const file = await readGguf(path);
    assert.equal(file.metadata.get('llama.block_count'), 32);
    assert.ok(file.warnings.some((w) => w.includes('99')));
  });

  test('先頭しか読まないので、大きなファイルでも全部は抱えない', async () => {
    const path = await writeTmp({ kvs: NORMAL, tensors: BIG_TENSORS, padTo: 4 * 1024 * 1024 });
    const file = await readGguf(path, { headBytes: 4096 });
    assert.equal(file.fileBytes, 4 * 1024 * 1024);
    assert.equal(file.metadata.get('llama.block_count'), 32);
  });
});

describe('量子化の名前', () => {
  test('知っている番号は名前になる', () => {
    assert.equal(quantName(12), 'Q4_K');
    assert.equal(quantName(0), 'F32');
    assert.equal(quantName(30), 'BF16');
  });

  test('知らない番号は、名前を作らない', () => {
    assert.equal(quantName(9999), undefined);
  });

  test('表に無い量子化のビット数は推測しない', () => {
    assert.equal(bitsFor('SOMETHING_NEW'), undefined);
    assert.equal(bitsFor(undefined), undefined);
    assert.equal(bitsFor('Q4_K_M'), 4.83);
  });

  test('小さなテンソルは主な量子化の判定に混ぜない', async () => {
    const path = await writeTmp({ kvs: NORMAL, tensors: BIG_TENSORS });
    const file = await readGguf(path);
    // F32 の正規化係数が 1 件あるが、支配的なのは Q4_K
    assert.equal(dominantQuant(file), 'Q4_K');
  });
});

describe('諸元への解釈', () => {
  test('揃っていれば諸元になる', async () => {
    const path = await writeTmp({
      kvs: NORMAL, tensors: BIG_TENSORS, padTo: 4 * 1024 ** 3,
    });
    const file = await readGguf(path);
    const { spec, missing } = toModelSpec(file);
    assert.deepEqual(missing, []);
    assert.ok(spec);
    assert.equal(spec!.layers, 32);
    assert.equal(spec!.kvHeads, 8, 'GQA を読めていない');
    assert.equal(spec!.headDim, 128, '4096 / 32');
    assert.equal(spec!.bitsPerWeight, 4.83);
    // 4GB を 4.83bit/重み で割ると、おおよそ 7B 前後になる
    assert.ok(spec!.paramsB > 5 && spec!.paramsB < 9, `${spec!.paramsB}B`);
  });

  test('足りなければ諸元を作らない。半端な値を渡さない', async () => {
    const path = await writeTmp({
      kvs: [['general.architecture', 8, 'llama'], ['llama.block_count', 4, 32]],
      tensors: BIG_TENSORS,
    });
    const file = await readGguf(path);
    const r = toModelSpec(file);
    assert.equal(r.spec, undefined);
    assert.ok(r.missing.some((m) => m.includes('embedding_length')));
    assert.ok(r.missing.some((m) => m.includes('head_count')));
  });

  test('量子化が読めなければ諸元を作らない', async () => {
    const path = await writeTmp({ kvs: NORMAL });
    const file = await readGguf(path);
    const r = toModelSpec(file);
    assert.equal(r.spec, undefined);
    assert.ok(r.missing.some((m) => m.includes('量子化')));
  });

  test('GQA の指定が無ければ、そう断ってヘッド数を使う', async () => {
    const kvs = NORMAL.filter(([k]) => k !== 'llama.attention.head_count_kv');
    const path = await writeTmp({ kvs, tensors: BIG_TENSORS, padTo: 1024 ** 3 });
    const r = toModelSpec(await readGguf(path));
    assert.equal(r.spec!.kvHeads, 32);
    assert.ok(r.notes.some((n) => n.includes('head_count_kv')));
  });

  test('MoE は活性パラメータを分けて持つ', async () => {
    const kvs: Kv[] = [
      ...NORMAL,
      ['llama.expert_count', 4, 8],
      ['llama.expert_used_count', 4, 2],
    ];
    const path = await writeTmp({ kvs, tensors: BIG_TENSORS, padTo: 4 * 1024 ** 3 });
    const r = toModelSpec(await readGguf(path));
    assert.ok(r.spec!.activeParamsB);
    assert.ok(Math.abs(r.spec!.activeParamsB! - r.spec!.paramsB / 4) < 0.01);
    assert.ok(r.notes.some((n) => n.includes('MoE')));
  });

  test('書いてあることを名前で引ける形にする', async () => {
    const file = await readGguf(await writeTmp({ kvs: NORMAL }));
    const f = extractFacts(file);
    assert.equal(f.architecture, 'llama');
    assert.equal(f.name, 'Test Llama 7B');
    assert.equal(f.contextLength, 8192);
    assert.equal(f.vocabSize, 3);
  });

  test('アーキテクチャが違えば、そのキーで引く', async () => {
    const path = await writeTmp({
      kvs: [
        ['general.architecture', 8, 'qwen2'],
        ['qwen2.block_count', 4, 48],
        ['llama.block_count', 4, 99],
      ],
    });
    const f = extractFacts(await readGguf(path));
    assert.equal(f.layers, 48, '別のアーキテクチャの値を拾っている');
  });
});

describe('人が確かめるための表示', () => {
  test('読めた値と、諸元にできたかどうかが出る', async () => {
    const path = await writeTmp({
      kvs: NORMAL, tensors: BIG_TENSORS, padTo: 4 * 1024 ** 3,
    });
    const file = await readGguf(path);
    const out = formatGguf(file, toModelSpec(file));
    assert.ok(out.includes('llama'));
    assert.ok(out.includes('32'));
    assert.ok(out.includes('Q4_K'));
    assert.ok(out.includes('諸元として解釈した結果'));
  });

  test('作れなかったときは、何が足りないかを出す', async () => {
    const file = await readGguf(await writeTmp({ kvs: NORMAL }));
    const out = formatGguf(file, toModelSpec(file));
    assert.ok(out.includes('諸元にはできませんでした'));
    assert.ok(out.includes('足りない'));
    assert.ok(out.includes('推測で埋めない'));
  });

  test('日本語の見出しでも列が揃う（文字数ではなく幅で揃える）', async () => {
    const file = await readGguf(await writeTmp({ kvs: NORMAL }));
    const out = formatGguf(file, toModelSpec(file));
    const width = (t: string) => [...t].reduce((n, ch) => {
      const c = ch.codePointAt(0)!;
      return n + (c >= 0x2e80 && c <= 0xa4cf ? 2 : 1);
    }, 0);
    const rows = out.split('\n')
      .filter((l) => l.startsWith('  ') && /[^\s]\s{2,}[^\s]/.test(l));
    const starts = rows.map((l) => width(l.slice(0, l.search(/\s{2,}(?=\S)/) + l.match(/\s{2,}(?=\S)/)![0].length)));
    assert.equal(new Set(starts).size, 1, `値の開始位置が揃っていない: ${[...new Set(starts)]}`);
  });

  test('記載が無いところは (記載なし) と出る。埋めない', async () => {
    const file = await readGguf(await writeTmp({
      kvs: [['general.architecture', 8, 'llama']],
    }));
    const out = formatGguf(file, toModelSpec(file));
    assert.ok(out.includes('(記載なし)'));
  });
});
