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
    assert.ok(small.length <= 120 + 80, `取り分を大きく超えている: ${small.length}`);
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
    const narrow = renderMap(rankedEntries(index, seedFrom(index, 'heartbeat')), { chars: 90 });
    assert.doesNotMatch(narrow, /leaf\.ts/);
    assert.equal(covers(narrow, index, seedFrom(index, 'onlyHere を直したい')), false);
  });

  test('起点が立たないなら、そのままでよい（作り直す理由が無い）', async () => {
    const index = await buildIndex(await project());
    const map = renderMap(rankedEntries(index), { chars: 100_000 });
    assert.equal(covers(map, index, seedFrom(index, 'まったく関係のない話')), true);
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
