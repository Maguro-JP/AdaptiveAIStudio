/**
 * 取ってこられるモデルの一覧。
 *
 * llama-server は自前で用意できるようになったが、**動かす中身が無かった**。
 * 「GGUF を手で落として置いてください」では、llama.cpp の道は
 * 実質「詳しい人向け」のままになる。
 *
 * ここに書くのは「どこの、どの量子化を」までで、
 * **ファイル名は書かない**。配布側の名前は変わるし、
 * 分割されていることもある。決め打ちにすると静かに壊れるので、
 * 名前は取ってくるときに一覧から選ぶ（model-install.ts）。
 */

export interface CatalogEntry {
  id: string;
  /** 配布元（Hugging Face のリポジトリ名） */
  repo: string;
  /** 量子化。ファイル名の中から、これを含むものを選ぶ。 */
  quant: string;
  /**
   * Ollama での名前。
   * 同じモデルでも、配布の形が違うので名前が別になる。
   * どちらの道でも同じ id で頼めるように、ここで対応を持つ。
   */
  ollama: string;
  /** おおよその大きさ。取る前に人へ伝えるため。 */
  approxGB: number;
  /** どういうときに使うか */
  note: string;
  license: string;
}

/**
 * 最初の一つ。
 *
 * 小さいこと（すぐ落ちてくる）と、8GB VRAM でも余裕で載ることを優先している。
 * 賢さでは選んでいない。**まず動くところまで行けること**が目的で、
 * 賢いモデルはそのあと各自で足せばよい。
 */
export const STARTER_ID = 'qwen2.5-coder-1.5b';

export const AVAILABLE_MODELS: CatalogEntry[] = [
  {
    id: STARTER_ID,
    repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen2.5-coder:1.5b',
    approxGB: 1.1,
    note: 'まず動かすための最小構成。軽い書き換えや読み取りなら通る。',
    license: 'Apache-2.0',
  },
  {
    id: 'qwen2.5-coder-7b',
    repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen2.5-coder:7b',
    approxGB: 4.7,
    note: '実用の下限。8GB VRAM に載る。',
    license: 'Apache-2.0',
  },
  {
    id: 'qwen2.5-coder-14b',
    repo: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen2.5-coder:14b',
    approxGB: 9.0,
    note: '8GB VRAM には載りきらない。一部をCPUに逃がして動かす。',
    license: 'Apache-2.0',
  },
];

export function lookupCatalog(id: string): CatalogEntry | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

/**
 * 人に見せる一覧。
 * 使っている道によって、実際に取ってくるものの名前が違う。
 * 出しておかないと、あとで一覧に出てこない名前が並んで混乱する。
 */
export function formatCatalog(runtimeId: 'llamacpp' | 'ollama' = 'llamacpp'): string {
  const lines = ['取ってこられるモデル', ''];
  for (const m of AVAILABLE_MODELS) {
    const mark = m.id === STARTER_ID ? ' ←まずこれ' : '';
    lines.push(`  ${m.id.padEnd(22)} 約${m.approxGB}GB  ${m.license}${mark}`);
    lines.push(`  ${' '.repeat(22)} ${m.note}`);
    lines.push(`  ${' '.repeat(22)} 実体: ${runtimeId === 'llamacpp' ? `${m.repo}（${m.quant}）` : m.ollama}`);
  }
  return lines.join('\n');
}
