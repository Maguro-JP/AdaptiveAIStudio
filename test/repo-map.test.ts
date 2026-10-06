/**
 * 作業場の地図。
 *
 * **どこに何が在るかを先に渡す。**これが無いと、モデルは総当たりで探し、
 * 探すところで窓を使い切って、直すところまで辿り着かない。
 *
 * ここで見るのは「上位に何が来るか」。並べ方が壊れると、
 * **地図が在るのに役に立たない**という、いちばん気づきにくい壊れ方になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { buildIndex, refsIn, importedFromPackages, isExportedDecl } from '../src/agent/code-index.ts';
import {
  rankedEntries, seedFrom, renderMap, graphOf, pageRank, covers,
} from '../src/agent/repo-map.ts';

/** 背骨（core）が一つ在り、そこを何枚もが呼んでいる作業場。 */
async function project(): Promise<string> {
  const root = await tempDir('aas-map-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'core.ts'),
    'export function heartbeat(): number { return 1; }\n'
    + 'export class Engine { start() { return heartbeat(); } }\n'
    + 'function hidden() { return 2; }\n', 'utf8');
  await writeFile(join(root, 'src', 'leaf.ts'),
    'export function onlyHere(): number { return 3; }\n', 'utf8');
  for (const n of ['a', 'b', 'c', 'd']) {
    await writeFile(join(root, 'src', `${n}.ts`),
      `import { heartbeat, Engine } from './core.ts';\n`
      + `export function use${n.toUpperCase()}() { return heartbeat() + new Engine().start(); }\n`, 'utf8');
  }
  return root;
}

describe('呼ばれている数で並べる', () => {
  test('**何枚もから呼ばれているものが、上に来る**', async () => {
    const index = await buildIndex(await project());
    const top = rankedEntries(index).slice(0, 3).map((e) => e.name);
    assert.ok(top.includes('heartbeat') || top.includes('Engine'),
      `背骨が上に来ていない: ${top.join(', ')}`);
    const leafAt = rankedEntries(index).findIndex((e) => e.name === 'onlyHere');
    const coreAt = rankedEntries(index).findIndex((e) => e.name === 'heartbeat');
    assert.ok(coreAt < leafAt, `一度も呼ばれない方が上に来ている: ${coreAt} vs ${leafAt}`);
  });

  test('外に出していない名前は、地図に載せない', async () => {
    const index = await buildIndex(await project());
    const names = rankedEntries(index).map((e) => e.name);
    assert.ok(!names.includes('hidden'), '中だけの関数が載っている');
  });

  test('**`.` の後ろは、呼び出しとして数えない**', () => {
    // `arr.push(x)` の push は、誰かが定義した push を呼んでいるのではない。
    // 数えていたときは、地図の上位が push / path / split で埋まった。
    assert.ok(!refsIn('const a = []; a.push(value);').includes('push'));
    assert.ok(refsIn('heartbeat();').includes('heartbeat'));
  });

  /**
   * その場で名づけている所は、よその同じ名前を指していない。
   *
   * `async load(): Promise<void>` の `load` は自分のメソッドの名前で、
   * よその `export function load` への参照ではない。数えていたので、
   * `load()` を持つ 33 枚から `test/fake-llama-lib.ts` の `load` へ辺が張られ、
   * **repo map のいちばん上が試験用の模型**になっていた（三番目の 5 倍。実測）。
   * 直す先を探しているモデルに、まず模型を見せることになる。
   */
  test('**名づけている所は、参照として数えない**', () => {
    // 自分のメソッド・自分の型・自分の欄。どれも「この場の名前」。
    assert.ok(!refsIn('class A {\n  async load(): Promise<void> {}\n}').includes('load'),
      'メソッドの名前を、よその同じ名前への参照として数えている');
    assert.ok(!refsIn('type Verdict = "ok";').includes('Verdict'));
    assert.ok(!refsIn('  readonly holder?: number;').includes('holder'));
    assert.ok(!refsIn('export function how(task) { return task; }').includes('how'));
    assert.ok(!refsIn('const reader = 1;').includes('reader'));
    // **使う側は残す（対）。**ここまで落とすと、repo map が真っ白になる。
    assert.ok(refsIn('const got = await load();').includes('load'), '使う側まで落としている');
    assert.ok(refsIn('const box = new ProposalQueue(path);').includes('ProposalQueue'));
    assert.ok(refsIn('export function how(task) { return help(task); }').includes('help'));
  });

  test('**名づけている所からは、辺を張らない**', async () => {
    // 同じ形を小さく作る。`load()` を持つ本体が三枚、`load` を外に出す模型が一枚。
    const root = await tempDir('aas-map-decl-');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'test', 'fake-lib.ts'), 'export async function load() { return {}; }\n');
    for (const name of ['a', 'b', 'c']) {
      await writeFile(join(root, 'src', `${name}.ts`), [
        `export class Keeper${name.toUpperCase()} {`,
        '  async load(): Promise<void> {}',
        '}',
        `export function use${name.toUpperCase()}() { return heartbeat(); }`,
      ].join('\n'));
    }
    await writeFile(join(root, 'src', 'core.ts'), 'export function heartbeat() { return 1; }\n');
    const index = await buildIndex(root);
    /*
     * 見るのは**辺**。順位で見ると、小さな作り物では
     * 「名前を一つしか出していないファイルは、その一つに点が全部乗る」
     * という別の理由で上に来るので、直したものを見たことにならない
     * （この試験を書いたとき、実際にそれで落ちた）。
     */
    const g = graphOf(index);
    const into = (path: string) => {
      const at = g.files.indexOf(path);
      assert.ok(at >= 0, `${path} が索引に無い`);
      return [...g.out].filter(([, edges]) => edges.has(at)).map(([from]) => g.files[from]);
    };
    assert.deepEqual(into('test/fake-lib.ts'), [],
      'メソッドの名前から、よその同じ名前へ辺を張っている');
    // **呼んでいる側からは張る（対）。**ここまで落とすと repo map が真っ白になる。
    assert.deepEqual(into('src/core.ts').sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      '本当に呼んでいる所から辺が張れていない');
  });

  test('**外から入れた名前は、この置き場の誰かを指していない**', () => {
    const got = importedFromPackages(
      "import { describe, test } from 'node:test';\nimport { local } from './near.ts';\n",
    );
    assert.ok(got.has('describe'));
    assert.ok(got.has('test'));
    assert.ok(!got.has('local'), '相対の道から入れたものまで外扱いしている');
    assert.ok(!refsIn("import { describe } from 'node:test';\ndescribe('x');").includes('describe'));
  });

  test('外に出しているかを見分ける', () => {
    assert.equal(isExportedDecl('export function a() {'), true);
    assert.equal(isExportedDecl('function a() {'), false);
    assert.equal(isExportedDecl('  #private() {'), false);
    assert.equal(isExportedDecl('pub fn go() {'), true);
    assert.equal(isExportedDecl('func Exported() {'), true);
    assert.equal(isExportedDecl('func hidden() {'), false);
  });
});

describe('いま頼まれていることで、地図が変わる', () => {
  test('**名前を出せば、その周りが上に来る**', async () => {
    const index = await buildIndex(await project());
    const plain = rankedEntries(index).findIndex((e) => e.name === 'onlyHere');
    const asked = rankedEntries(index, seedFrom(index, 'onlyHere を直したい'))
      .findIndex((e) => e.name === 'onlyHere');
    assert.ok(asked < plain, `頼んだのに上がっていない: ${plain} → ${asked}`);
  });

  test('起点が無ければ、素の並びに戻る（落ちない）', async () => {
    const index = await buildIndex(await project());
    const seed = seedFrom(index, 'まったく関係のない話');
    assert.deepEqual(
      rankedEntries(index, seed).slice(0, 3).map((e) => e.name),
      rankedEntries(index).slice(0, 3).map((e) => e.name),
    );
  });
});

describe('点の配り方', () => {
  test('**合計が 1 から落ちない（行き止まりの分を捨てない）**', async () => {
    const index = await buildIndex(await project());
    const rank = pageRank(graphOf(index));
    const sum = rank.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `合計が 1 から離れている: ${sum}`);
  });

  test('ファイルが無ければ、空を返す（落ちない）', () => {
    const empty = { root: '/x', builtAt: '', files: [], skipped: 0 };
    assert.deepEqual(pageRank(graphOf(empty)), []);
    assert.deepEqual(rankedEntries(empty), []);
  });
});

describe('渡せる形にする', () => {
  test('**入り切らない分は、載せずに「載せていない」と言う**', async () => {
    const index = await buildIndex(await project());
    const entries = rankedEntries(index);
    const small = renderMap(entries, { chars: 120 });
    // 但し書きも取り分に入れる（後から足すと、システムプロンプトの組み立てで repo map が丸ごと落ちた）
    assert.ok(small.length <= 120, `取り分を超えている: ${small.length}`);
    assert.match(small, /載せていません/);
  });

  test('全部入るなら、但し書きは付けない', async () => {
    const index = await buildIndex(await project());
    const all = renderMap(rankedEntries(index), { chars: 100_000 });
    assert.doesNotMatch(all, /載せていません/);
    assert.match(all, /heartbeat/);
  });

  test('何も無ければ、空（見出しだけを渡さない）', () => {
    assert.equal(renderMap([], { chars: 1000 }), '');
  });
});

describe('名前を出していないファイルも、地図に載せる', () => {
  /**
   * 試験・画面・入口・記録には、外へ出す名前が一つも無い。名前が無いという
   * 理由で外していたが、**直す先としてはこれらがいちばん多い**。
   * この置き場の履歴 200 commit で測ったところ、直した先の 58% が
   * 地図に載りようが無いファイルだった（`scripts/bench.mjs`）。
   * 載らないものは、どれだけ並べ方を良くしても当たらない。
   */
  test('**外へ出す名前が無くても、道は載る**', async () => {
    const root = await project();
    await writeFile(join(root, 'src', 'core.test.ts'),
      "// 背骨を確かめる。\nimport { heartbeat } from './core.ts';\n"
      + 'function check() { return heartbeat(); }\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['src/core.test.ts'])), { chars: 100_000 });
    assert.match(map, /core\.test\.ts/, '直す先としていちばん多いものが載らない');
  });

  test('名前が無いファイルには、何のファイルかを添える', async () => {
    const root = await project();
    await writeFile(join(root, 'src', 'core.test.ts'),
      '// 背骨を確かめる。\nfunction check() { return 1; }\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['src/core.test.ts'])), { chars: 100_000 });
    assert.match(map, /core\.test\.ts.*背骨を確かめる/, '道だけでは何のファイルか分からない');
  });

  test('**起点が立っても、呼ばれていないファイルを消さない**', async () => {
    const root = await project();
    // どこからも呼ばれず、外へ出す名前も無い。記録・設定・画面がこの形。
    await writeFile(join(root, 'src', 'notes.test.ts'),
      '// 決めごとの控え。\nfunction memo() { return 1; }\n', 'utf8');
    const index = await buildIndex(root);
    // 起点は別の所（heartbeat）に立てる。**そこで消えてはいけない。**
    const seeded = rankedEntries(index, seedFrom(index, 'heartbeat を直したい'));
    assert.ok(seeded.some((e) => e.path.endsWith('notes.test.ts')),
      '起点を立てた途端、呼ばれていないファイルが並びから丸ごと消えている');
  });

  test('置くのは末尾。点の付いたものより前に出さない（対）', async () => {
    const root = await project();
    await writeFile(join(root, 'src', 'notes.test.ts'),
      '// 決めごとの控え。\nfunction memo() { return 1; }\n', 'utf8');
    const index = await buildIndex(root);
    const all = rankedEntries(index, seedFrom(index, 'heartbeat を直したい'));
    const zero = all.findIndex((e) => e.score <= 0);
    assert.ok(zero > 0, '点の付いたものが一つも無い（この試験が確かめられない）');
    // ここから先に、点の付いたものが混ざっていない。
    assert.ok(all.slice(zero).every((e) => e.score <= 0),
      '点の付いていないものが、付いているものより前に出ている');
  });

  test('**中身がそのまま出るものには、何も添えない**', async () => {
    const root = await project();
    await writeFile(join(root, 'thing.json'), '{ "name": "adaptive", "version": "0.3.0" }\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['thing.json'])), { chars: 100_000 });
    assert.match(map, /thing\.json/, 'この試験の前提が崩れている');
    assert.doesNotMatch(map, /thing\.json.*\{/, '狭い地図に JSON の中身を貼っている');
  });

  test('題のあとの見出しを、一言に混ぜない', async () => {
    const root = await project();
    await writeFile(join(root, 'guide.md'),
      '# 組織設計\n\n## 0. 肩書きではなく気質\n\n役職を担当と読まない。\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['guide.md'])), { chars: 100_000 });
    assert.match(map, /guide\.md {2}— 組織設計\n/, `見出しが混ざっている:\n${map.split('\n').filter((l) => l.includes('guide.md')).join('\n')}`);
  });

  test('切るときに、区切りまで戻す', async () => {
    const root = await project();
    // 区切りが後ろ寄り（40 文字の 6 割より後）。ここは戻して切れ端を残さない。
    await writeFile(join(root, 'late.md'),
      '# ああああああああああああああああああああああああああああああああ いいいいいいいい\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['late.md'])), { chars: 100_000 });
    const line = (map.split('\n').find((l) => l.startsWith('late.md')) ?? '').trim();
    assert.ok(!line.includes('い'), `切れ端が残っている: ${line}`);
  });

  test('戻しすぎるくらいなら、そのまま切る（対）', async () => {
    const root = await project();
    // 区切りが前寄り。ここで戻すと、一言のほとんどが消える。
    await writeFile(join(root, 'early.md'),
      '# ああああ いいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいい\n', 'utf8');
    const index = await buildIndex(root);
    const map = renderMap(rankedEntries(index, seedFrom(index, '', [], ['early.md'])), { chars: 100_000 });
    const line = (map.split('\n').find((l) => l.startsWith('early.md')) ?? '').trim();
    assert.ok(line.length > 20, `戻しすぎて、一言がほとんど消えている: ${line}`);
  });

  test('名前が在るファイルは、いままでどおり名前で出す（対）', async () => {
    const index = await buildIndex(await project());
    const map = renderMap(rankedEntries(index), { chars: 100_000 });
    assert.match(map, /src\/core\.ts\n {2}\d+: heartbeat/);
  });
});

describe('前と同じで済むなら、地図を作り直さない', () => {
  /**
   * 前置きが一文字でも変われば、相手（llama.cpp / ollama）はそこから先を
   * **履歴まで含めて**計算し直す。依頼ごとに地図を作り直すと、毎回そうなる。
   * 狭い機械ほど、それがそのまま待ち時間になる。
   */
  test('**いま探している所が載っているなら、そのままでよい**', async () => {
    const index = await buildIndex(await project());
    const map = renderMap(rankedEntries(index), { chars: 100_000 });
    assert.match(map, /core\.ts/);
    assert.equal(covers(map, index, seedFrom(index, 'heartbeat を直したい')), true);
  });

  test('**載っていない所を指したら、作り直す**', async () => {
    const index = await buildIndex(await project());
    // core.ts だけが載る、狭い地図。
    const narrow = renderMap(rankedEntries(index, seedFrom(index, 'heartbeat')), { chars: 140 });
    assert.doesNotMatch(narrow, /leaf\.ts/);
    assert.equal(covers(narrow, index, seedFrom(index, 'onlyHere を直したい')), false);
  });

  test('起点が立たないなら、そのままでよい（作り直す理由が無い）', async () => {
    const index = await buildIndex(await project());
    const map = renderMap(rankedEntries(index), { chars: 100_000 });
    assert.equal(covers(map, index, seedFrom(index, 'まったく関係のない話')), true);
  });

  test('**短い依頼が続いても、毎往復は作り直さない**', async () => {
    const root = await project();
    const index = await buildIndex(root);
    /*
     * 「そこ」「もう一度」のような短い依頼が続く形。ここで毎回作り直すと、
     * 相手は前置きから先を履歴ごと計算し直すので、狭い機械ほど待たされる。
     * 二度この形で壊した（起点の目盛りを変えたとき、探す道具の当て方を
     * 重ねたとき）。どちらも試験は全部通っていた。
     */
    const turns = ['heartbeat を直したい', 'まだ落ちる', 'そこ', 'もう一度', 'まだ'];
    const edited = ['src/core.ts'];
    let held = '';
    let built = 0;
    for (const text of turns) {
      const strong = seedFrom(index, text, [], edited, { search: false });
      if (held && covers(held, index, strong)) continue;
      held = renderMap(rankedEntries(index, seedFrom(index, text, [], edited)), { chars: 4000 });
      built += 1;
    }
    assert.ok(built < turns.length,
      `${turns.length} 往復で ${built} 回 作り直している（覚えておく意味が無い）`);
  });

  test('**薄く当たっただけのファイルを、地図に要求しない**', async () => {
    const root = await project();
    // 道にも名前にも出てこない語が、注釈にだけ在るファイル。
    await writeFile(join(root, 'src', 'leaf.ts'),
      '// telemetry counter\nexport function onlyHere(): number { return 3; }\n', 'utf8');
    const index = await buildIndex(root);
    const text = 'telemetry を直したい';

    // 並べるときは効く。ここは当ててよい。
    const loose = seedFrom(index, text);
    const at = index.files.findIndex((f) => f.path === 'src/leaf.ts');
    assert.ok((loose.get(at) ?? 0) > 0, 'この試験の前提が崩れている（薄くも当たっていない）');

    // **判断には使わない。**使うと「そこ」「もう一度」で毎往復作り直す。
    const strong = seedFrom(index, text, [], [], { search: false });
    assert.ok((strong.get(at) ?? 0) < 3,
      '薄く当たっただけのものを、言い切れる印として数えている');
    // leaf.ts が載っていない地図でも、作り直しを求めない。
    const narrow = renderMap(rankedEntries(index, seedFrom(index, 'heartbeat')), { chars: 140 });
    assert.doesNotMatch(narrow, /leaf\.ts/);
    assert.equal(covers(narrow, index, strong), true,
      '薄く当たっただけのものを地図に要求している（毎往復かならず作り直す）');
  });

  test('地図がまだ無いなら、作る', async () => {
    const index = await buildIndex(await project());
    assert.equal(covers('', index, seedFrom(index, 'heartbeat')), false);
  });
});

describe('直前に書き換えたファイルを、起点にする', () => {
  /**
   * ファイル名の出ない依頼（「まだ落ちる」「そこ直して」）が普通にある。
   * 語からは起点が一つも立たないので、素の並びが出て、**いま直している
   * ファイルが載らない**。Cursor が近くの編集を手がかりにしているのを見て入れた。
   */
  test('**名前の出ない依頼でも、直していたファイルが上に来る**', async () => {
    const index = await buildIndex(await project());
    const plain = rankedEntries(index, seedFrom(index, 'まだ落ちる'))
      .slice(0, 3).map((e) => e.path);
    assert.ok(!plain.some((p) => p.endsWith('leaf.ts')),
      `起点が無くても leaf が上に来ている（この試験が確かめられない）: ${plain.join(', ')}`);

    const withEdit = rankedEntries(index, seedFrom(index, 'まだ落ちる', [], ['src/leaf.ts']))
      .slice(0, 3).map((e) => e.path);
    assert.ok(withEdit.some((p) => p.endsWith('leaf.ts')),
      `直していたファイルが上に来ていない: ${withEdit.join(', ')}`);
  });

  test('新しく触ったものほど、強い', async () => {
    const index = await buildIndex(await project());
    const seed = seedFrom(index, '', [], ['src/leaf.ts', 'src/a.ts']);
    const at = (p: string) => index.files.findIndex((f) => f.path === p);
    assert.ok((seed.get(at('src/leaf.ts')) ?? 0) > (seed.get(at('src/a.ts')) ?? 0),
      '十往復前に触ったものが、いま触ったものと同じ重さになっている');
  });

  test('触っていなければ、何も変わらない（対）', async () => {
    const index = await buildIndex(await project());
    const before = rankedEntries(index, seedFrom(index, 'heartbeat')).map((e) => e.name);
    const after = rankedEntries(index, seedFrom(index, 'heartbeat', [], [])).map((e) => e.name);
    assert.deepEqual(after, before);
  });
});
