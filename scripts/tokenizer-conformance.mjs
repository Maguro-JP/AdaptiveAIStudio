/**
 * こちらの数え方が、本物と同じか確かめる。
 *
 * トークン数の見積もりは、窓に何を残すかの土台になっている。ずれれば、
 * 落としてはいけないものを落とす。**そのときモデルは、依頼を忘れた状態で
 * 答える。**画面からは「このモデルが馬鹿だ」に見えるので、原因に辿り着けない。
 *
 * だから、**自分の実装を自分で確かめない。**同じ GGUF を llama.cpp にも
 * 読ませ、同じ文で数えさせて、数が一致するかを見る。
 *
 * 数え方はモデルごとに違うので、両方の形（SPM と BPE）で試す。
 * node-llama-cpp が無い場所では、飛ばして「飛ばした」と言う。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let getLlama;
try {
  ({ getLlama } = await import('node-llama-cpp'));
} catch {
  console.log('node-llama-cpp が無いので飛ばします（数え方の一致は確かめていません）');
  process.exit(0);
}

const { readGguf } = await import(join(root, 'src', 'runtime', 'gguf.ts'));
const { vocabFrom, tokenizerFor } = await import(join(root, 'src', 'agent', 'tokenizer.ts'));

/**
 * 試す文。**こちらが選ばない。**
 *
 * 手で選んだ16文で「一致した」と言っていたが、選んだのはこちらなので、
 * 通るものを選んだのと区別が付かない。**無作為に作ってぶつける。**
 *
 * ただし**種は固定する。**走らせるたびに違う文になると、落ちたものを
 * 手元で再現できない（走らせる場所で結果が変わる試験になる）。
 */
function makeRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 混ぜる字。**ここで手を抜くと、抜いた種類だけ誰も試していないことになる。** */
const POOL = [
  ...'abcdefghijklmnopqrstuvwxyzABCXYZ0123456789 \n\t.,!?-_/\\\'"()[]{}#@$%^&*+=<>|~`',
  'あ', '日', '本', '語', 'を', 'ア', 'ー', '漢', '字', '　', '、', '。',
  '😀', '👨‍👩‍👧', 'é', 'ü', 'ß', '中', '文', '한', '글', '🇯🇵', '\u200b', '\r',
];

function randomText(rand, max) {
  const n = Math.floor(rand() * max);
  let out = '';
  for (let i = 0; i < n; i += 1) out += POOL[Math.floor(rand() * POOL.length)];
  return out;
}

/** 手で選んだものも残す。**端**は無作為では出にくい。 */
const EDGES = ['', ' ', '\n', 'x', 'the', ' the', '   ', '日本語', 'a\nb'];

const dir = mkdtempSync(join(tmpdir(), 'aas-tok-'));
// 終わるときに消す（どの道で終わっても。消していなかったので、回すたびに aas-tok- が一つずつ溜まった）
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
let bad = 0;

for (const [label, args] of [['SPM', []], ['BPE', ['--bpe']]]) {
  const path = join(dir, `${label}.gguf`);
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), path, ...args], {
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    console.log(`${label}: 組めませんでした`, built.stderr?.slice(0, 300));
    bad += 1;
    continue;
  }

  const spec = vocabFrom((await readGguf(path)).metadata);
  const mine = spec && tokenizerFor(spec);
  if (!mine) { console.log(`${label}: こちらが数え方を作れませんでした`); bad += 1; continue; }

  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: path });
  try {
    const rand = makeRandom(20260905);
    // 短いものを多く、長いものも少し。**長い方でしか通らない道がある**
    // （繋ぎ方を山で持つところは、短い文では一度も回らない）。
    const cases = [
      ...EDGES,
      ...Array.from({ length: 600 }, () => randomText(rand, 40)),
      ...Array.from({ length: 40 }, () => randomText(rand, 1500)),
    ];
    let ng = 0;
    for (const text of cases) {
      const real = model.tokenize(text, false).length;
      const got = mine.count(text);
      if (real !== got) {
        ng += 1;
        if (ng <= 3) console.log(`  ずれ ${JSON.stringify(text.slice(0, 60))} 本物=${real} こちら=${got}`);
      }
    }
    if (ng === 0) console.log(`${label}: ${cases.length} 件すべて一致（語彙 ${spec.tokens.length}）`);
    else { console.log(`${label}: ずれ ${ng} 件`); bad += ng; }

    /*
     * 速さ。**時間そのものを見ない。**機械によって違うので、それを閾値に
     * すると走らせる場所で結果が変わる。**文字数を5倍にしたとき何倍に
     * なるか**を見る。二乗で効いていれば 25 倍前後になる。
     *
     * 実際に二乗で書いていて、5万文字で 8.6 秒かかっていた。道具の結果は
     * それくらいの長さになるので、数えるたびにそれだけ止まっていた。
     */
    const line = 'the quick brown fox 日本語のテキスト ';
    const at = (n) => {
      const text = line.repeat(Math.ceil(n / line.length)).slice(0, n);
      mine.count(text.slice(0, 200)); // 一度温めてから測る
      const t0 = process.hrtime.bigint();
      mine.count(text);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const small = Math.max(at(10_000), 0.5);
    const large = at(50_000);
    const ratio = large / small;
    if (ratio > 10) {
      console.log(`${label}: 長い文で急に遅くなります（5倍の長さで ${ratio.toFixed(1)} 倍）`);
      bad += 1;
    } else {
      console.log(`${label}: 長さに比例（5倍の長さで ${ratio.toFixed(1)} 倍、5万文字 ${large.toFixed(0)}ms）`);
    }
  } finally {
    await model.dispose();
    await llama.dispose();
  }
}

if (bad > 0) {
  console.log(`一致しません（${bad} 件）。窓の勘定がずれます。`);
  process.exit(1);
}
console.log('本物と同じ数え方になっています');
