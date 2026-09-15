/**
 * 読んだものを、諸元に直す。
 *
 * 読み取り（gguf.ts）と解釈（ここ）を分けているのは、
 * 「書いてあった」と「そう解釈した」を混ぜないため。
 * 混ぜると、値が変なときにどちらが悪いのか分からなくなる。
 *
 * ここでも埋めない。足りないものは足りないと言う。
 */
import { basename } from 'node:path';
import type { GgufFile, GgufValue } from './gguf.ts';
import { quantName } from './gguf.ts';
import type { ModelSpec } from './spec.ts';
import { QUANT_BITS, type QuantName } from './spec.ts';
import { padTo } from '../cli/width.ts';

/** 数として読める形なら数にする。読めないなら undefined。 */
function num(v: GgufValue | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

export interface GgufFacts {
  /** general.architecture。層数などのキーはこれを頭に付けて引く。 */
  architecture?: string;
  name?: string;
  layers?: number;
  embeddingLength?: number;
  contextLength?: number;
  headCount?: number;
  /** GQA のときヘッド数より少ない。KVキャッシュ量を決める。 */
  headCountKv?: number;
  /** MoE のエキスパート数。1トークンあたりの活性パラメータが変わる。 */
  expertCount?: number;
  expertUsedCount?: number;
  /** 語彙数。埋め込みの大きさに効く。 */
  vocabSize?: number;
}

/** 書いてあることを、名前で引ける形に並べ替える。 */
export function extractFacts(file: GgufFile): GgufFacts {
  const md = file.metadata;
  const arch = md.get('general.architecture');
  const architecture = typeof arch === 'string' ? arch : undefined;
  const byArch = (suffix: string): GgufValue | undefined =>
    architecture ? md.get(`${architecture}.${suffix}`) : undefined;

  const name = md.get('general.name');
  const tokens = md.get('tokenizer.ggml.tokens');

  return {
    architecture,
    name: typeof name === 'string' ? name : undefined,
    layers: num(byArch('block_count')),
    embeddingLength: num(byArch('embedding_length')),
    contextLength: num(byArch('context_length')),
    headCount: num(byArch('attention.head_count')),
    headCountKv: num(byArch('attention.head_count_kv')),
    expertCount: num(byArch('expert_count')),
    expertUsedCount: num(byArch('expert_used_count')),
    vocabSize: Array.isArray(tokens) ? tokens.length : undefined,
  };
}

export interface SpecResult {
  spec?: ModelSpec;
  facts: GgufFacts;
  /** 何が分かって、何が分からなかったか。 */
  missing: string[];
  notes: string[];
}

/**
 * 重みの実バイト数。テンソル一覧が全部読めているときだけ意味を持つ。
 * 読めていない分があるなら、ファイル全体の大きさで代用する方が正しい。
 */
export function weightBytesFromTensors(file: GgufFile): number | undefined {
  if (file.tensors.length === 0) return undefined;
  if (file.warnings.some((w) => w.includes('テンソル一覧'))) return undefined;
  // 量子化ごとのブロック構造までは踏み込まない。
  // ここで欲しいのは「ファイルの大部分は重み」という前提の確認だけ。
  return file.fileBytes;
}

/** テンソルに使われている量子化形式のうち、いちばん多いもの。 */
export function dominantQuant(file: GgufFile): string | undefined {
  if (file.tensors.length === 0) return undefined;
  const count = new Map<number, number>();
  for (const t of file.tensors) {
    // 小さなテンソル（正規化係数など）は F32 のまま置かれる。数に入れない。
    if (t.elements < 1_000_000) continue;
    count.set(t.typeId, (count.get(t.typeId) ?? 0) + t.elements);
  }
  let best: { id: number; n: number } | undefined;
  for (const [id, n] of count) if (!best || n > best.n) best = { id, n };
  return best ? quantName(best.id) : undefined;
}

/** 量子化名から、1重みあたりの実効ビット数を引く。表に無いものは推測しない。 */
export function bitsFor(quant: string | undefined): number | undefined {
  if (!quant) return undefined;
  const table: Record<string, number> = {
    ...QUANT_BITS,
    F32: 32, F16: 16, BF16: 16,
    Q4_0: 4.5, Q4_1: 5.0, Q5_0: 5.5, Q5_1: 6.0,
    Q2_K: 3.35, Q3_K: 3.9, Q4_K: 4.83, Q5_K: 5.7, Q6_K: 6.6,
    IQ2_XXS: 2.06, IQ2_XS: 2.31, IQ2_S: 2.5, IQ3_XXS: 3.06,
    IQ3_S: 3.44, IQ1_S: 1.56, IQ1_M: 1.75, IQ4_NL: 4.5, IQ4_XS: 4.25,
  };
  return table[quant as QuantName];
}

/**
 * 諸元に直す。
 *
 * 足りないものがあれば spec を返さない。
 * 半端な諸元で「載る／載らない」を計算されるより、
 * 「分からない」と言われた方が安全なので。
 */
export function toModelSpec(file: GgufFile, id?: string): SpecResult {
  const facts = extractFacts(file);
  const missing: string[] = [];
  const notes: string[] = [...file.warnings];

  if (!facts.architecture) missing.push('general.architecture');
  if (facts.layers === undefined) missing.push('block_count（層数）');
  if (facts.embeddingLength === undefined) missing.push('embedding_length（埋め込み次元）');
  if (facts.headCount === undefined) missing.push('attention.head_count（ヘッド数）');

  const quant = dominantQuant(file);
  if (!quant) missing.push('量子化形式（テンソル一覧が読めていません）');
  const bits = bitsFor(quant);
  if (quant && bits === undefined) missing.push(`量子化 ${quant} の実効ビット数（表にありません）`);

  if (missing.length > 0) return { facts, missing, notes };

  const layers = facts.layers!;
  const headCount = facts.headCount!;
  const embedding = facts.embeddingLength!;
  // GQA の指定が無いモデルは、KVヘッド数 = ヘッド数。
  const kvHeads = facts.headCountKv ?? headCount;
  if (facts.headCountKv === undefined) {
    notes.push('head_count_kv がないので、KVヘッド数はヘッド数と同じとして扱います。');
  }
  const headDim = Math.round(embedding / headCount);

  // 総パラメータ数は、重みの総バイト数と1重みあたりのビット数から逆算する。
  // 層構造から積み上げるより、実物の大きさを信じる方が確実。
  const paramsB = (file.fileBytes * 8) / bits! / 1e9;

  const spec: ModelSpec = {
    id: id ?? facts.name ?? basename(file.path),
    paramsB,
    layers,
    kvHeads,
    headDim,
    bitsPerWeight: bits!,
  };

  // MoE は 1トークンあたりに動く重みが少ない。速度の見積もりが変わる。
  if (facts.expertCount && facts.expertCount > 1 && facts.expertUsedCount) {
    const ratio = facts.expertUsedCount / facts.expertCount;
    spec.activeParamsB = paramsB * ratio;
    notes.push(
      `MoE です（${facts.expertUsedCount}/${facts.expertCount} を使用）。`
      + `1トークンあたりの活性パラメータは約 ${spec.activeParamsB.toFixed(1)}B として扱います。`,
    );
  }

  return { spec, facts, missing, notes };
}

/** 人が読む形。合っているかを目で確かめられることが、いまは何より大事。 */
export function formatGguf(file: GgufFile, result: SpecResult): string {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
  const lines: string[] = [];
  lines.push(`${basename(file.path)}  (${gb(file.fileBytes)}, GGUF v${file.version})`);

  const f = result.facts;
  lines.push('', '# 書いてあったこと');
  const row = (label: string, value: unknown) =>
    lines.push(`  ${padTo(label, 22)}${value ?? '(記載なし)'}`);
  row('アーキテクチャ', f.architecture);
  row('名前', f.name);
  row('層数', f.layers);
  row('埋め込み次元', f.embeddingLength);
  row('ヘッド数', f.headCount);
  row('KVヘッド数', f.headCountKv);
  row('文脈長', f.contextLength);
  row('語彙数', f.vocabSize);
  if (f.expertCount) row('エキスパート', `${f.expertUsedCount ?? '?'} / ${f.expertCount}`);

  const quant = dominantQuant(file);
  lines.push('', '# テンソル');
  row('読めた数', file.tensors.length);
  row('主な量子化', quant ? `${quant}（実効 ${bitsFor(quant) ?? '?'} bit/重み）` : undefined);

  if (result.spec) {
    lines.push('', '# 諸元として解釈した結果');
    row('パラメータ数', `約 ${result.spec.paramsB.toFixed(1)}B`);
    if (result.spec.activeParamsB) row('活性パラメータ', `約 ${result.spec.activeParamsB.toFixed(1)}B`);
    row('ヘッド次元', result.spec.headDim);
    row('KVヘッド数', result.spec.kvHeads);
  } else {
    lines.push('', '# 諸元にはできませんでした');
    for (const m of result.missing) lines.push(`  足りない: ${m}`);
    lines.push('  推測で埋めない方針のため、ここは空のままにします。');
  }

  if (result.notes.length > 0) {
    lines.push('', '# 気づき');
    for (const n of result.notes) lines.push(`  ${n}`);
  }
  return lines.join('\n');
}
