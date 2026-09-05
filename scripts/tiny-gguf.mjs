/**
 * 最小の GGUF を組む。
 *
 * **中身は無意味でよい。**重みは乱数なので、返ってくる文字も意味を成さない。
 * ここで見たいのは「本物のライブラリが、本物の形の GGUF を読んで、
 * 文脈を作って、文字を返すところまで通るか」だけ。
 *
 * これが無いと、中で読む道（inproc）は**一度も本物で動かさないまま**になる。
 * 網の外からモデルを取ってこられない場所でも、ここだけは確かめられる。
 *
 * 使い方:
 *   node scripts/tiny-gguf.mjs <出す先.gguf>
 *
 * 詰まった所（実際に落ちた順に）:
 *   1. 足りないメタデータで落ちる。C++ 側の例外なので、行ごと落ちる
 *   2. SPM の字句器は `<0x00>`〜`<0xFF>` を必ず引く。無いと落ちる
 *   3. 窓が小さいと、決まり（system）だけで溢れる
 */
import { writeFileSync } from 'node:fs';

const D = 32, FF = 64, LAYERS = 1, HEADS = 4;

/**
 * 数え方（字句器）を選ぶ。`--bpe` を付けると gpt2 の方で組む。
 *
 * **数え方はモデルごとに違う。**こちらの実装が本物と同じか確かめるには、
 * 両方の形の GGUF が要る（片方だけだと、もう片方は誰も試していない）。
 */
const BPE = process.argv.includes('--bpe');

/**
 * モデル同梱の話し方（chat_template）を入れるか。
 *
 * **本物のモデルはこれを持っている。**持っていないと、こちらは型を
 * 当てずっぽうで決め（`GUESSED_WRAPPERS`）、道具の呼び方も本文に書かせる
 * 道へ落ちる。つまり**偽物でだけ通る道**をずっと試していたことになる。
 * 本物で最初に通る道を、ここでも通せるようにする。
 */
const TEMPLATE = process.argv.includes('--chat-template');

/** GPT-2 のバイト→字の写し。空白は Ġ、改行は Ċ になる、あれ。 */
function byteToUnicode() {
  const bs = [];
  for (let b = 0x21; b <= 0x7e; b += 1) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b += 1) bs.push(b);
  for (let b = 0xae; b <= 0xff; b += 1) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  const out = [];
  bs.forEach((b, i) => { out[b] = String.fromCodePoint(cs[i]); });
  return out;
}

const B2U = byteToUnicode();
/** 繋ぎ方。**順番が効く。**先に書いたものから繋がる。 */
const MERGES = [];
const NAMES = [];
if (BPE) {
  for (let i = 0; i < 256; i += 1) NAMES.push(B2U[i]);
  // 「Ġt」「he」「Ġthe」…と段々に繋ぐ。順番の効き方まで試したいので、
  // 一段では終わらない形にしておく。
  const pairs = [
    ['t', 'h'], ['th', 'e'], [B2U[0x20], 'the'],
    ['a', 'b'], ['ab', 'c'], ['e', 'f'],
  ];
  for (const [a, b] of pairs) { MERGES.push(`${a} ${b}`); NAMES.push(a + b); }
} else {
  // SPM の字句器は <0x00>〜<0xFF> を必ず引く（無いと落ちる）。
  NAMES.push('<unk>', '<s>', '</s>');
  for (let i = 0; i < 256; i += 1) NAMES.push(`<0x${i.toString(16).toUpperCase().padStart(2, '0')}>`);
  for (const t of ['\u2581', '\u2581t', 'he', '\u2581the', 'ab', 'abc', 'ef']) NAMES.push(t);
  for (let i = 0; i < 16; i += 1) NAMES.push(`t${i}`);
}
const VOCAB = NAMES.length;
const parts = [];
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };
const kv = (k, type, val) => parts.push(str(k), u32(type), val);
const arr = (elemType, items) => Buffer.concat([u32(elemType), u64(items.length), ...items]);

const tokens = NAMES.map((n) => str(n));
/** 0=通常 1=通常 2=未知 3=制御 6=バイト */
const types = BPE
  ? NAMES.map(() => 1)
  : NAMES.map((n, i) => (i < 3 ? 3 : /^<0x/.test(n) ? 6 : 1));
/** SPM は点数で繋ぐ順を決める。**後ろほど高く**して、長いものを優先させる。 */
const scores = NAMES.map((n, i) => (BPE ? 0 : i));

const tensors = [
  ['token_embd.weight', [D, VOCAB]],
  ['output_norm.weight', [D]],
  ['output.weight', [D, VOCAB]],
];
for (let l = 0; l < LAYERS; l += 1) {
  tensors.push(
    [`blk.${l}.attn_norm.weight`, [D]],
    [`blk.${l}.attn_q.weight`, [D, D]],
    [`blk.${l}.attn_k.weight`, [D, D]],
    [`blk.${l}.attn_v.weight`, [D, D]],
    [`blk.${l}.attn_output.weight`, [D, D]],
    [`blk.${l}.ffn_norm.weight`, [D]],
    [`blk.${l}.ffn_gate.weight`, [D, FF]],
    [`blk.${l}.ffn_up.weight`, [D, FF]],
    [`blk.${l}.ffn_down.weight`, [FF, D]],
  );
}

parts.push(Buffer.from('GGUF', 'latin1'), u32(3), u64(tensors.length), u64(0));
const kvStart = parts.length;
kv('general.architecture', 8, str('llama'));
kv('general.name', 8, str('tiny'));
kv('llama.block_count', 4, u32(LAYERS));
kv('llama.context_length', 4, u32(2048));
kv('llama.embedding_length', 4, u32(D));
kv('llama.feed_forward_length', 4, u32(FF));
kv('llama.attention.head_count', 4, u32(HEADS));
kv('llama.attention.head_count_kv', 4, u32(HEADS));
kv('llama.attention.layer_norm_rms_epsilon', 6, f32(1e-5));
kv('llama.rope.dimension_count', 4, u32(D / HEADS));
kv('tokenizer.ggml.model', 8, str(BPE ? 'gpt2' : 'llama'));
kv('tokenizer.ggml.tokens', 9, arr(8, tokens));
kv('tokenizer.ggml.scores', 9, arr(6, scores.map((s) => f32(s))));
if (BPE) kv('tokenizer.ggml.merges', 9, arr(8, MERGES.map((m) => str(m))));
kv('tokenizer.ggml.token_type', 9, arr(5, types.map((t) => u32(t))));
kv('tokenizer.ggml.bos_token_id', 4, u32(1));
kv('tokenizer.ggml.eos_token_id', 4, u32(2));
kv('general.alignment', 4, u32(32));
kv('general.file_type', 4, u32(0));
kv('llama.vocab_size', 4, u32(VOCAB));
kv('llama.rope.freq_base', 6, f32(10000));
kv('tokenizer.ggml.unknown_token_id', 4, u32(0));
kv('tokenizer.ggml.padding_token_id', 4, u32(0));
if (TEMPLATE) {
  // 本物（Qwen 等）と同じ形。role ごとに囲って、最後に助手の番を開ける。
  kv('tokenizer.chat_template', 8, str(
    "{% for m in messages %}<|im_start|>{{ m['role'] }}\n{{ m['content'] }}<|im_end|>\n{% endfor %}"
    + '{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}',
  ));
}
kv('tokenizer.ggml.add_bos_token', 7, Buffer.from([1]));
kv('tokenizer.ggml.add_eos_token', 7, Buffer.from([0]));
const kvCount = (parts.length - kvStart) / 3;
parts[3] = u64(kvCount);

let offset = 0;
const datas = [];
for (const [name, dims] of tensors) {
  parts.push(str(name), u32(dims.length), ...dims.map((d) => u64(d)), u32(0), u64(offset));
  const n = dims.reduce((a, b) => a * b, 1);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) buf.writeFloatLE((Math.random() - 0.5) * 0.1, i * 4);
  datas.push(buf);
  offset += Math.ceil(buf.length / 32) * 32;
}

let head = Buffer.concat(parts);
const pad = (Math.ceil(head.length / 32) * 32) - head.length;
head = Buffer.concat([head, Buffer.alloc(pad)]);
const body = [];
let at = 0;
for (const d of datas) {
  body.push(d);
  const p = (Math.ceil(d.length / 32) * 32) - d.length;
  if (p) body.push(Buffer.alloc(p));
  at += d.length + p;
}
const out = process.argv[2];
writeFileSync(out, Buffer.concat([head, ...body]));
console.log('組みました:', out, Buffer.concat([head, ...body]).length, 'バイト');
