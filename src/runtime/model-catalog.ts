/**
 * 取ってこられるモデルの一覧。
 *
 * **この表は必ず古くなる。** 実際、最初に書いたときは
 * 私（書いた側）が知っている名前をそのまま並べた結果、
 * 世代がまるごと1つ古いものが並んだ。
 * だから、ここは「入口」であって「檻」ではないという作りにしてある。
 *
 *   ・一覧に無い名前も、そのまま渡せる（Ollama の名前、HF の置き場名）
 *   ・つまり、この表が古くなっても、新しいものは使える
 *   ・表は「最初の一歩をどこに置くか」だけを決める
 *
 * ここに書くのは「どこの、どの量子化を」までで、**ファイル名は書かない**。
 * 配布側の名前は変わるし、分割されていることもある。
 * 名前は取ってくるときに一覧から選ぶ（model-install.ts）。
 *
 * 確認日: 2026-08-31（ollama.com/library と huggingface.co を検索で確認）。
 * **次に触るときは、まず現行かどうかを調べること。**
 * 一度目は「知っている名前」を書いて1世代古いものを並べ、
 * 二度目は「知っている名前で検索して」確認した気になり、また古いままだった。
 * 探すのではなく、確かめに行ってしまうと、持っている思い込みが強化されるだけになる。
 */
import { how } from '../cli/how.ts';

export interface CatalogEntry {
  id: string;
  /** 配布元（Hugging Face のリポジトリ名） */
  repo: string;
  /** 量子化。ファイル名の中から、これを含むものを選ぶ。 */
  quant: string;
  /**
   * Ollama での名前。
   * 同じモデルでも配布の形が違うので、名前が別になる。
   */
  ollama: string;
  /** おおよその大きさ。取る前に人へ伝えるため。 */
  approxGB: number;
  note: string;
  license: string;
  /**
   * 配置の計画（placement.ts）に渡す値。**取ってくる前に、この機械でどう置くかを言うため。**
   * 配布元のファイルの大きさと、GGUF の先頭に書いてある値を読んで写した（2026-11-15）。
   * 無いもの（名前を直に渡したもの）は、`approxGB` と見当で数える。
   */
  facts?: {
    /** ファイルの大きさ（バイト）。 */
    bytes: number;
    layers: number;
    /** 1 トークンあたりの KV（バイト、f16）。2 × 層 × KV のヘッド × ヘッドの次元 × 2。 */
    kvBytesPerToken: number;
    /** 1 トークンで使う重みの割合（MoE だけ）。 */
    activeRatio?: number;
  };
}

/**
 * 最初の一つ。
 *
 * 小さいこと（すぐ落ちてくる）を優先している。賢さでは選んでいない。
 * **まず動くところまで行けること**が目的で、良いモデルはそのあと各自で足す。
 */
export const STARTER_ID = 'qwen3.5-4b';

export const AVAILABLE_MODELS: CatalogEntry[] = [
  {
    id: STARTER_ID,
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.5:4b',
    approxGB: 2.5,
    note: 'まず動かすための最小構成。軽い読み書きなら通る。',
    license: 'Apache-2.0',
    facts: { bytes: 2_740_937_888, layers: 32, kvBytesPerToken: 131_072 },
  },
  {
    id: 'qwen3.5-9b',
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.5:9b',
    approxGB: 6.6,
    note: '8GB VRAM にそのまま載る。日常の作業はこれで足りる。',
    license: 'Apache-2.0',
    facts: { bytes: 5_680_522_464, layers: 32, kvBytesPerToken: 131_072 },
  },
  {
    // 総35B・活性3B の MoE。VRAM には載りきらないが、
    // 1トークンあたり 3B しか使わないので、RAM へ逃がしても実用速度が出る。
    // この道具の実行可能性プランナが、いちばん効く形。
    id: 'qwen3.6-coding-35b',
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.6:35b-a3b-coding-nvfp4',
    approxGB: 22,
    note: 'コード向けの本命。8GB VRAM + 32GB RAM なら、CPUへ逃がして動かせる。',
    license: 'Apache-2.0',
    facts: { bytes: 22_134_528_992, layers: 40, kvBytesPerToken: 81_920, activeRatio: 0.18 },
  },
  /*
   * ここから下は、大きいモデル（2026-11-15 に足した）。
   *
   * 「メモリより大きいものは読まない」をやめた（placement.ts）ので、大きいものも並べる。
   * 配布元に在ること・ファイルの大きさ・層の数は、足す日に確かめた（Hugging Face の一覧と、GGUF の先頭 16MB を読んだ。
   * Ollama の名前は ollama.com の一覧）。122B（A10B）は配布が 3 つに分割されていて、ここでは取ってこられないので載せていない。
   */
  {
    id: 'qwen3.6-27b',
    repo: 'unsloth/Qwen3.6-27B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.6:27b',
    approxGB: 15.7,
    note: '27B。16GB 以上の VRAM なら全部載る。載らない機械では、載る分だけ GPU に置いて残りはメモリで動く（遅い）。',
    license: 'Apache-2.0',
    facts: { bytes: 16_817_244_384, layers: 64, kvBytesPerToken: 262_144 },
  },
  {
    id: 'qwen3.5-27b',
    repo: 'unsloth/Qwen3.5-27B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.5:27b',
    approxGB: 15.6,
    note: '27B の一つ前の世代。3.6 が合わないときの比べ先。',
    license: 'Apache-2.0',
    facts: { bytes: 16_740_812_704, layers: 64, kvBytesPerToken: 262_144 },
  },
  {
    id: 'qwen3.5-35b-a3b',
    repo: 'unsloth/Qwen3.5-35B-A3B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.5:35b-a3b',
    approxGB: 20.5,
    note: '総 35B・1 トークンに使うのは 3B の MoE。メモリに置いても、同じ大きさの普通のモデルより速い。',
    license: 'Apache-2.0',
    facts: { bytes: 22_016_023_168, layers: 40, kvBytesPerToken: 81_920, activeRatio: 0.18 },
  },
];

/**
 * 同じモデルの、量子化の違う版。**配布元に在るものだけ**を書く（2026-11-28 に、Hugging Face の一覧でファイルの名前と大きさを見た）。
 *
 * 置き方の計画（placement.ts）が「1 つ小さい量子化なら全部メモリに入る」と言うために使う。ここに無い版は、言わない。
 * 層の数と KV は、元の版と同じ（量子化で変わらない）。GGUF を置く道でだけ取ってこられる（Ollama での名前は確かめていないので、持たない）。
 */
export interface CatalogVariant {
  /** 元の版の id。 */
  of: string;
  quant: string;
  /** ファイルの大きさ（バイト）。 */
  bytes: number;
}

export const QUANT_VARIANTS: CatalogVariant[] = [
  { of: 'qwen3.6-27b', quant: 'q3_k_m', bytes: 13_586_217_184 },
  { of: 'qwen3.5-27b', quant: 'q3_k_m', bytes: 13_505_116_064 },
  { of: 'qwen3.5-35b-a3b', quant: 'q3_k_m', bytes: 16_356_375_168 },
  { of: 'qwen3.6-coding-35b', quant: 'q3_k_m', bytes: 16_600_710_112 },
];

/** 量子化の違う版の id（`qwen3.6-27b@q3_k_m`）。 */
export function variantId(of: string, quant: string): string {
  return `${of}@${quant}`;
}

/** 量子化の違う版を、取ってくるときの形にする。一覧に無ければ undefined。 */
export function lookupVariant(id: string, variants: readonly CatalogVariant[] = QUANT_VARIANTS): CatalogEntry | undefined {
  const v = variants.find((x) => variantId(x.of, x.quant) === id);
  const base = v ? lookupCatalog(v.of) : undefined;
  if (!v || !base) return undefined;
  return {
    ...base, id, quant: v.quant, approxGB: Math.round((v.bytes / 1024 ** 3) * 10) / 10,
    note: `${base.id} の小さい量子化（${v.quant}）。`,
    ...(base.facts ? { facts: { ...base.facts, bytes: v.bytes } } : {}),
  };
}

/** 名前の比べ方。大文字・小文字と区切りを見ない。 */
function plainName(x: string): string {
  return x.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/** 配布元の名前から、モデルの名前の部分（`unsloth/Qwen3.6-27B-GGUF` → `qwen3.627b`）。 */
function familyKey(repo: string): string {
  return plainName(repo.slice(repo.lastIndexOf('/') + 1).replace(/-gguf$/i, ''));
}

/** ファイルの名前から量子化（`Qwen3.6-27B-UD-Q4_K_M.gguf` → `q4_k_m`）。読めなければ undefined。 */
export function quantOf(ref: string): string | undefined {
  const m = /(?:^|[-_.])(q\d(?:_[a-z0-9]+)*|bf16|f16|f32)(?=\.gguf$|[-.]|$)/i.exec(ref);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** 手元のファイルが、一覧のどのモデルか（配布元と量子化）。一覧に無ければ undefined。 */
export function catalogMatch(ref: string): { family: string; quant?: string } | undefined {
  const name = plainName(ref);
  const hit = AVAILABLE_MODELS
    .filter((m) => name.includes(familyKey(m.repo)))
    .sort((a, b) => familyKey(b.repo).length - familyKey(a.repo).length)[0];
  if (!hit) return undefined;
  const quant = quantOf(ref);
  return { family: hit.repo, ...(quant ? { quant } : {}) };
}

/** 一覧と、量子化の違う版を、一つの並びにする（別の版を探すときの候補）。 */
export function catalogVersions(variants: readonly CatalogVariant[] = QUANT_VARIANTS): Array<{
  id: string; family: string; quant: string; bytes: number; facts?: CatalogEntry['facts'];
}> {
  const out = AVAILABLE_MODELS.map((m) => ({
    id: m.id, family: m.repo, quant: m.quant, bytes: m.facts?.bytes ?? m.approxGB * 1024 ** 3, ...(m.facts ? { facts: m.facts } : {}),
  }));
  for (const v of variants) {
    const e = lookupVariant(variantId(v.of, v.quant), variants);
    if (e) out.push({ id: e.id, family: e.repo, quant: e.quant, bytes: v.bytes, ...(e.facts ? { facts: e.facts } : {}) });
  }
  return out;
}

export function lookupCatalog(id: string): CatalogEntry | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

/**
 * 人に見せる一覧。
 * 使っている道によって、実際に取ってくるものの名前が違う。
 */
export function formatCatalog(runtimeId: 'llamacpp' | 'ollama' = 'llamacpp'): string {
  const lines = ['取ってこられるモデル', ''];
  for (const m of AVAILABLE_MODELS) {
    const mark = m.id === STARTER_ID ? ' ←まずこれ' : '';
    lines.push(`  ${m.id.padEnd(22)} 約${m.approxGB}GB  ${m.license}${mark}`);
    lines.push(`  ${' '.repeat(22)} ${m.note}`);
    lines.push(`  ${' '.repeat(22)} 実体: ${runtimeId === 'llamacpp' ? `${m.repo}（${m.quant}）` : m.ollama}`);
  }
  lines.push('');
  lines.push('  この一覧は古くなります。新しいものは名前を直接渡してください。');
  lines.push(runtimeId === 'llamacpp'
    ? `    ${how('models', '--get Qwen/Qwen3-8B-GGUF')}     （置き場の名前をそのまま）`
    : `    ${how('models', '--get qwen3-coder:30b')}        （Ollama の名前をそのまま）`);
  return lines.join('\n');
}

/**
 * カタログに載っている家族の名前（`qwen3.5` など）。
 *
 * **何も入っていないときの、訊く手がかり。**入れた直後は一つも入って
 * いないので、そこで黙ると「最初の一つ」がこの表のまま固定される。
 * この表は手で書いたもので、必ず古くなる（上に書いたとおり、実際に
 * 二度古かった）。**古くなったことに気づく道を、表の外に置く。**
 */
export function catalogFamilies(): string[] {
  const out = new Set<string>();
  for (const m of AVAILABLE_MODELS) {
    // `qwen3.5:4b` → `qwen3.5`。大きさの札は家族ではない。
    const at = m.ollama.indexOf(':');
    out.add(at < 0 ? m.ollama : m.ollama.slice(0, at));
  }
  return [...out];
}
