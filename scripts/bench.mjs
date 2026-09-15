/**
 * 土台を測る。**モデルを呼ばずに。**
 *
 * ここまで測ってきたのは部品ごとだった（順位・作り直しの回数・窓の割り当て）。
 * それぞれは良くなっていても、**全体として良くなったかは一度も見ていない**。
 * 「Cursor と競える」「後はモデルの差」と言うには、まず
 * **モデルの差が混ざらない所**を切り出して測る必要がある。
 *
 * ## 何を正解にするか
 *
 * **こちらで依頼を選ばない。**選ぶと、通るものを選んだのと区別が付かない。
 * 使うのは git の履歴。一つの commit は、
 *
 *   件名     = そのとき何をしたかったか（＝依頼にいちばん近いもの）
 *   触った先 = その正解
 *
 * になっている。この置き場の履歴は利用者が書いたもので、こちらは選べない。
 *
 * ## 何と比べるか
 *
 * **同じ索引・同じ依頼・同じ窓のまま、並べ方だけ差し替える。**
 * そうしないと、何が効いたのか言えない。
 *
 *   名前の順        並べない（道の名前で並べるだけ）
 *   呼ばれている数   素の PageRank。依頼を見ない
 *   いま            依頼で起点を立てた PageRank
 *
 * ## ここで測れないもの
 *
 * 「探し回った道具の呼び出し数」はモデルを呼ばないと出ない。ここには無い。
 * Cursor / Claude Code そのものとの突き合わせも、中が見えないのでここには無い。
 * **無いものを在るように書かない。**
 *
 * 索引はいまの木から組む。昔の commit のときとは中身が違う
 * （そのころ無かったファイルは「いまの索引に無い」として外れる）。
 *
 * 使い方:
 *   node scripts/bench.mjs [--commits 200] [--chars 4000] [--k 0]
 *
 *   --commits  さかのぼる commit の数
 *   --chars    地図に使える文字数（窓の広さに相当）
 *   --k        0 なら地図に載ったかで見る。1以上なら上位 k 件で見る
 *   --kind     正解の種類ごとに分けて出す
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildIndex } from '../src/agent/code-index.ts';
import { rankedEntries, seedFrom, renderMap } from '../src/agent/repo-map.ts';
import { rerankByBody, rerankShare } from '../src/agent/rerank.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? Number(process.argv[at + 1]) : fallback;
};
const COMMITS = arg('commits', 200);
const CHARS = arg('chars', 4000);
const K = arg('k', 0);

/**
 * 触ったファイルが多すぎる commit は使わない。
 *
 * 一斉に直したものには「そこが正解」と言える一点が無い。
 * **落とした数は必ず出す**（都合よく選んでいないことが見えるように）。
 */
const TOO_WIDE = 8;

/**
 * commit の区切り。
 *
 * NUL は git の引数に渡せない（Node が撥ねる）ので、件名に出ることのない
 * 制御文字（RS）を使う。git 側は `%x1e` と書く。
 */
const SEP = '\u001e';

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function cases(index) {
  const known = new Set(index.files.map((f) => f.path));
  const raw = git('log', '--no-merges', `-${COMMITS}`, '--format=%x1e%s', '--name-only');
  const out = [];
  const skipped = { wide: 0, gone: 0 };
  for (const chunk of raw.split(SEP).slice(1)) {
    const [subject, ...rest] = chunk.split('\n');
    const files = rest.map((l) => l.trim()).filter(Boolean);
    if (files.length === 0) continue;
    if (files.length > TOO_WIDE) { skipped.wide += 1; continue; }
    // いまの索引に無いファイルは測りようが無い（消えた・改名された・索引の対象外）。
    const want = files.filter((f) => known.has(f));
    if (want.length === 0) { skipped.gone += 1; continue; }
    out.push({ subject: subject ?? '', want });
  }
  return { list: out, skipped };
}

/**
 * 正解の種類。**まとめた一つの数字だけを見ない。**
 *
 * この置き場は、直すたびに `docs/DECISIONS.md` を書く決まりになっている。
 * それは「どこを直すか」ではなく**決まりごと**で、しかも決まり自体は前置きに
 * 既に入っている。地図がそこを指す必要は無いのに、正解に数えると
 * まとめた数字だけが下がる。分けて出せば、それが見える。
 */
function kindOf(path) {
  if (/^(docs\/|CLAUDE\.md|README|.*\.md$)/.test(path)) return '記録';
  if (/^(package|tsconfig|\.github|.*\.json$|.*\.ya?ml$)/.test(path)) return '設定';
  if (/^test\/|\.test\.|\.spec\./.test(path)) return '試験';
  if (/^scripts\//.test(path)) return '道具';
  return 'コード';
}

/** 道の名前で並べるだけ。地図というものが無かったときの下限。 */
function byName(index) {
  return index.files
    .flatMap((f) => f.symbols
      .filter((s) => s.exported)
      .map((s) => ({ path: f.path, line: s.line, name: s.name, score: 0 })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** 正解のうち、地図に載ったものの割合。 */
function hit(entries, want) {
  const map = K > 0
    ? entries.slice(0, K).map((e) => e.path).join('\n')
    : renderMap(entries, { chars: CHARS });
  let got = 0;
  for (const w of want) if (map.includes(w)) got += 1;
  return got / want.length;
}

const index = await buildIndex(root);
const { list, skipped } = cases(index);
if (list.length === 0) { console.error('測れる commit がありません'); process.exit(1); }

const plain = byName(index);
const flat = rankedEntries(index);
const ways = {
  '名前の順': () => plain,
  '呼ばれている数': () => flat,
  // 本番と同じ道を通す。**上位だけ本文を読んで並べ直す（rerank）ところまで含める。**
  'いま（依頼で起点）': async (c) => rankedEntries(
    index,
    await rerankByBody(index, c.subject, seedFrom(index, c.subject), rerankShare(CHARS)),
  ),
};

/*
 * **件名にファイル名が出ているものは、別に数える。**
 *
 * 出ていれば当たって当然で、混ぜると土台の力を高く見せてしまう。
 * 名前の出ない依頼（「まだ落ちる」「そこ直して」）の方が、実際には多い。
 */
const bare = list.filter((c) => !c.want.some((w) => {
  const base = w.split('/').pop() ?? w;
  return c.subject.includes(w) || c.subject.includes(base);
}));

const width = (s) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

console.log(`測った commit: ${list.length} 件`
  + `（一斉に直していて外した ${skipped.wide} 件、いまの索引に無い ${skipped.gone} 件）`);
console.log(`うち、件名にファイル名が出ていないもの: ${bare.length} 件`);
console.log(K > 0 ? `見方: 上位 ${K} 件に入ったか` : `見方: ${CHARS} 文字の地図に載ったか`);
console.log('');
console.log(`${pad('並べ方', 22)}${pad('全部', 10)}名前が出ていないものだけ`);
for (const [name, way] of Object.entries(ways)) {
  const score = async (rows) => {
    let sum = 0;
    for (const c of rows) sum += hit(await way(c), c.want);
    return sum / rows.length;
  };
  const all = await score(list);
  const nameless = await score(bare);
  console.log(`${pad(name, 22)}${pad(`${(all * 100).toFixed(1)}%`, 10)}${(nameless * 100).toFixed(1)}%`);
}

if (process.argv.includes('--kind')) {
  const seen = {};
  const got = {};
  for (const c of list) {
    const entries = await ways['いま（依頼で起点）'](c);
    const map = K > 0 ? entries.slice(0, K).map((e) => e.path).join('\n') : renderMap(entries, { chars: CHARS });
    for (const w of c.want) {
      const k = kindOf(w);
      seen[k] = (seen[k] ?? 0) + 1;
      if (map.includes(w)) got[k] = (got[k] ?? 0) + 1;
    }
  }
  console.log('');
  console.log('正解の種類ごと（いま）:');
  let work = 0;
  let workAll = 0;
  for (const k of Object.keys(seen).sort((a, b) => seen[b] - seen[a])) {
    const g = got[k] ?? 0;
    console.log(`  ${pad(k, 8)}${pad(`${g}/${seen[k]}`, 10)}${(g / seen[k] * 100).toFixed(1)}%`);
    if (k !== '記録' && k !== '設定') { work += g; workAll += seen[k]; }
  }
  console.log(`  ${pad('（直す先だけ）', 18)}${(work / workAll * 100).toFixed(1)}%`);
}
