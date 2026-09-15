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
  },
  {
    id: 'qwen3.5-9b',
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    quant: 'q4_k_m',
    ollama: 'qwen3.5:9b',
    approxGB: 6.6,
    note: '8GB VRAM にそのまま載る。日常の作業はこれで足りる。',
    license: 'Apache-2.0',
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
    ? '    npm run models -- --get Qwen/Qwen3-8B-GGUF     （置き場の名前をそのまま）'
    : '    npm run models -- --get qwen3-coder:30b        （Ollama の名前をそのまま）');
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
