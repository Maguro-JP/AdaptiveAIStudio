/**
 * 直しが当たるかを測る。**モデルを呼ばずに。**
 *
 * Cursor が速く見えるいちばんの理由は、**編集が一度で当たる**ことにある。
 * 当たらないと、モデルは「見つかりません」を受け取って同じことを何度も試す。
 * 一往復ぶんの生成をまるごと払い、しかも直っていない。ローカルの小さい
 * モデルほど、ここで落ちる回数が多い。
 *
 * `scripts/bench.mjs` が repo map を測るのと同じやり方で、ここは
 * `applyEdit`（`src/agent/tools/write-kind.ts`）を測る。
 *
 * ## 何を正解にするか
 *
 * **こちらで例を選ばない。**選ぶと、通るものを選んだのと区別が付かない。
 * git の履歴の diff を使う。一つの hunk は、
 *
 *   `-` 側 = 直す前にファイルに在った文字列（＝ find が当てるべきもの）
 *   `+` 側 = 直した後（＝ replace）
 *
 * になっている。**当たったかどうかは、直した後の中身と突き合わせて決める。**
 * 「例外が出なかった」ではなく、「利用者が実際に書いた結果と同じになったか」。
 *
 * ## モデルの崩し方
 *
 * 本物のモデルは `-` 側をそのまま返さない。小さいモデルほど崩す。
 * 実際に見た崩れ方を、そのまま形にする。
 *
 *   そのまま     崩さない。ここが 100% でないなら、素の当てが壊れている
 *   字下げ       行頭の空白を潰す・増やす
 *   行末         行末の空白を落とす
 *   注釈落ち     真ん中のコメント行を一行落とす
 *   空行入り     真ん中に空行を入れる
 *   省略         真ん中の数行を落とす（「…」で省いた形）
 *
 * ## ここで測れないもの
 *
 * 「何往復で直せたか」はモデルを呼ばないと出ない。ここには無い。
 * Cursor そのものとの突き合わせも、中が見えないのでここには無い。
 * **無いものを在るように書かない。**
 *
 * 使い方:
 *   node scripts/bench-edit.mjs [--commits 400] [--verbose]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const COMMITS = Number(arg('commits', 400));
const VERBOSE = process.argv.includes('--verbose');

const { applyEdit } = await import(join(root, 'src', 'agent', 'tools', 'write-kind.ts'));

/**
 * git の履歴から hunk を集める。
 *
 * 一つの hunk を「その場所だけを持つ小さいファイル」として扱う。
 * ファイル全体を持ってくると、同じ文字列が他所にも在って
 * 「何箇所にも当てはまる」で落ちる。測りたいのはそこではない。
 * ただし**周りが無いと当たり過ぎる**ので、前後の文脈行は残す。
 */
function hunks() {
  const raw = execFileSync('git', [
    'log', '--no-merges', `-${COMMITS}`, '-U6', '--format=%x1e', '--',
    '*.ts', '*.mjs', '*.js',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  const out = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) { out.push({ minus: [], plus: [] }); continue; }
    const at = out[out.length - 1];
    if (!at) continue;
    if (line.startsWith('-')) { at.minus.push(line.slice(1)); at.plus.push(null); }
    else if (line.startsWith('+')) { at.plus.push(line.slice(1)); }
    else if (line.startsWith(' ')) { at.minus.push(line.slice(1)); at.plus.push(line.slice(1)); }
    else if (line.startsWith('\x1e') || line.startsWith('diff ') || line.startsWith('index ')
      || line.startsWith('--- ') || line.startsWith('+++ ')) { out.push(undefined); }
  }

  const cases = [];
  for (const h of out) {
    if (!h) continue;
    const before = h.minus.join('\n');
    const after = h.plus.filter((l) => l !== null).join('\n');
    // 消しただけ・足しただけは、find の当てを測る題材にならない。
    const changed = h.minus.length > 0 && h.plus.some((l) => l !== null);
    if (!changed || before === after) continue;
    // 短すぎるものは、崩しようがない（崩すと別物になる）。
    if (h.minus.length < 6) continue;
    // 長すぎるものは、履歴の中で数が少なく、偏る。
    if (h.minus.length > 60) continue;
    cases.push({ before, after });
  }
  return cases;
}

/**
 * 「変えた所」を切り出す。
 *
 * hunk 全体を find にすると、前後の文脈まで含めた長い塊になる。
 * モデルはそういう渡し方をしない（直す所の周りを少しだけ渡す）。
 * 上下から、同じ行が続いている間を削る。
 */
function core(before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head += 1;
  let tail = 0;
  while (tail < b.length - head && tail < a.length - head
    && b[b.length - 1 - tail] === a[a.length - 1 - tail]) tail += 1;
  // 前後を2行だけ残す。一意にするための取っ掛かりが要る。
  const from = Math.max(0, head - 2);
  const toB = Math.min(b.length, b.length - tail + 2);
  const toA = Math.min(a.length, a.length - tail + 2);
  return { find: b.slice(from, toB).join('\n'), replace: a.slice(from, toA).join('\n') };
}

/** モデルの崩し方。返り値が undefined なら、この崩し方は当てはまらない。 */
const DAMAGE = {
  そのまま: (s) => s,
  字下げ: (s) => {
    const lines = s.split('\n');
    const at = lines.findIndex((l) => /^\s+\S/.test(l));
    if (at < 0) return undefined;
    lines[at] = lines[at].replace(/^\s+/, '  ');
    return lines.join('\n') === s ? undefined : lines.join('\n');
  },
  行末: (s) => {
    const lines = s.split('\n');
    let touched = false;
    const out = lines.map((l, i) => {
      if (i === 0 || i === lines.length - 1 || l.trim().length === 0) return l;
      touched = true;
      return `${l}  `;
    });
    return touched ? out.join('\n') : undefined;
  },
  注釈落ち: (s) => {
    const lines = s.split('\n');
    /*
     * **塊の切れ目は落とさない。**`/**` を落とすと、探す塊そのものが別のものに
     * なる。落とした後の find は**ファイルの中に本当に在る**ので、こちらはそこへ
     * 正しく当てる。それを「外した」と数えると、直しようのないものを不具合と
     * して数えることになる（実際に数えていた）。落とすのは注釈の中身の行だけ。
     */
    const at = lines.findIndex((l, i) => i > 0 && i < lines.length - 1
      && /^\s*(\/\/|\*)\s*\S/.test(l) && !/^\s*(\/\*|\*\/)/.test(l));
    if (at < 0) return undefined;
    lines.splice(at, 1);
    return lines.join('\n');
  },
  空行入り: (s) => {
    const lines = s.split('\n');
    if (lines.length < 4) return undefined;
    lines.splice(Math.floor(lines.length / 2), 0, '');
    return lines.join('\n');
  },
  省略: (s) => {
    const lines = s.split('\n');
    if (lines.length < 8) return undefined;
    const mid = Math.floor(lines.length / 2);
    lines.splice(mid, 2);
    return lines.join('\n');
  },
};

const cases = hunks();
if (cases.length === 0) {
  console.error('題材が集まりませんでした（履歴が浅い？）');
  process.exit(1);
}

const tally = {};
for (const name of Object.keys(DAMAGE)) {
  tally[name] = { tried: 0, hit: 0, wrong: 0, missed: 0, ambiguous: 0 };
}

for (const c of cases) {
  const { find, replace } = core(c.before, c.after);
  if (find.length === 0 || find === replace) continue;
  for (const [name, damage] of Object.entries(DAMAGE)) {
    const broken = damage(find);
    if (broken === undefined) continue;
    tally[name].tried += 1;
    const got = applyEdit(c.before, broken, replace, false);
    if (got.hits === 0) {
      tally[name].missed += 1;
      if (VERBOSE && name !== 'そのまま') {
        console.log(`--- 当たらなかった（${name}）\n${broken.slice(0, 200)}\n`);
      }
      continue;
    }
    // **当てられずに断ったのと、当てて壊したのを、混ぜない。**
    // 何箇所にも当てはまるときは中身を変えずに返る。これは断りであって、
    // 壊れてはいない（モデルは find を伸ばして呼び直せる）。
    if (got.text === c.before && got.hits > 1) { tally[name].ambiguous += 1; continue; }
    // **当てただけでは足りない。**利用者が実際に書いた結果と同じか。
    if (got.text === c.after) tally[name].hit += 1;
    else {
      tally[name].wrong += 1;
      if (VERBOSE) console.log(`--- 当てたが中身が違う（${name}）`);
    }
  }
}

console.log(`題材 ${cases.length} 件（履歴 ${COMMITS} commit）\n`);
console.log('崩し方        試した     当てた   別物になった   当てられない   曖昧で断った');
for (const [name, t] of Object.entries(tally)) {
  if (t.tried === 0) continue;
  const pct = (t.hit / t.tried * 100).toFixed(1);
  console.log(
    `${name.padEnd(12)}${String(t.tried).padStart(6)}`
    + `${(`${t.hit} (${pct}%)`).padStart(15)}`
    + `${String(t.wrong).padStart(13)}${String(t.missed).padStart(15)}`
    + `${String(t.ambiguous).padStart(15)}`,
  );
}
console.log('');
console.log('「別物になった」は、当てた場所が違うか、真ん中を余計に消したもの。');
console.log('**当てられないより悪い。**モデルは直ったと思って先へ進む。');
console.log('「曖昧で断った」は中身を変えずに返したもの。壊れてはいない。');
