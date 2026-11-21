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
