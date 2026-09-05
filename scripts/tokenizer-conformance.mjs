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
import { mkdtempSync } from 'node:fs';
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

/** 短いものから、長いものへ。**多バイトの字も入れる**（そこで一番ずれる）。 */
const CASES = [
  '', 'x', 'the', ' the', 'theabc', 'abcdef', 'abab',
  'hello there', 'the the the', 'a b c',
  '日本語', 'これは日本語の文です。', 'the 日本語 abc',
  'a\nb', '  ', 'ABC abc 123',
];

const dir = mkdtempSync(join(tmpdir(), 'aas-tok-'));
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
    let ng = 0;
    for (const text of CASES) {
      const real = model.tokenize(text, false).length;
      const got = mine.count(text);
      if (real !== got) {
        ng += 1;
        console.log(`  ずれ ${JSON.stringify(text)} 本物=${real} こちら=${got}`);
      }
    }
    if (ng === 0) console.log(`${label}: ${CASES.length} 件すべて一致（語彙 ${spec.tokens.length}）`);
    else bad += ng;
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
