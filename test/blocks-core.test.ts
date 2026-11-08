/**
 * ブロックでつくる画面の中身（docs/BLOCKS.md）。組んだ形から JavaScript を作る、型でつなげるかを決める、
 * 保存して読み直す、手順の形と行き来する、向きを変えても中身が変わらない、を動かして見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS, canConnect, connect, makeNode, emptyGraph, compile, run, serialize, parseGraph, removeNodes, duplicateNodes,
  makeHistory, searchBlocks, exportScript, sampleFizzBuzz, sampleHello, sampleUmbrella, runWorkflow, compileWorkflow,
  graphToWorkflow, workflowToGraph, availableOutputs, makeStep, emptyWorkflow, serializeFile, parseFile, autoLayout,
  dailyDue, graphFormatGuide, normalizeDirection, readingOrder, COMPARE_WORDS, WRAP_STEP, type Graph, type Workflow,
} from '../src/ui/web/blocks-core.js';

const FIZZ = '1,2,Fizz,4,Buzz,Fizz,7,8,Fizz,Buzz,11,Fizz,13,14,FizzBuzz';

async function outputOf(g: Graph): Promise<string> {
  const out: unknown[] = [];
  const got = await run(g, { show: (v) => out.push(v) });
  assert.equal(got.ok, true, got.message);
  return out.join(',');
}

describe('JavaScript を作って動かす', () => {
  test('FizzBuzz の見本が 1〜15 を正しく出す', async () => {
    assert.equal(await outputOf(sampleFizzBuzz()), FIZZ);
  });
  test('作った文は同じ形なら毎回同じ', () => {
    assert.equal(compile(sampleFizzBuzz()).code, compile(sampleFizzBuzz()).code);
    assert.match(compile(sampleFizzBuzz()).code, /^for \(let v_n1_each = 1; v_n1_each <= 15;/);
  });
  test('つないでいない口は、ブロックに書いた値を使う', async () => {
    assert.equal(await outputOf(sampleHello()), 'こんにちは、ブロック');
  });
  test('0 で割ると、そのブロックを指して止まる', async () => {
    const g = emptyGraph();
    g.nodes.push(makeNode('number', 'a'), Object.assign(makeNode('calc', 'b'), {}), makeNode('show', 'c'));
    g.nodes[1]!.values.op = '÷';
    assert.equal(connect(g, { node: 'a', port: 'out' }, { node: 'b', port: 'b' }).ok, true);
    connect(g, { node: 'b', port: 'out' }, { node: 'c', port: 'value' });
    const got = await run(g, { show: () => undefined });
    assert.equal(got.ok, false);
    assert.equal(got.node, 'b');
    assert.match(String(got.message), /0 では割れません/);
  });
  test('終わらないくり返しは上限で止める', async () => {
    const g = emptyGraph();
    const r = makeNode('repeat', 'r');
    r.values.to = 1e9;
    const s = makeNode('show', 's');
    g.nodes.push(r, s);
    connect(g, { node: 'r', port: 'each' }, { node: 's', port: 'value' });
    const got = await run(g, { show: () => undefined }, { limit: 1000 });
    assert.equal(got.ok, false);
    assert.match(String(got.message), /1000 回を超えた/);
  });
  test('ファイル・天気・AI は rt を通る（await で待つ）', async () => {
    const g = emptyGraph();
    g.nodes.push(makeNode('readFile', 'r', 0, 0), makeNode('writeFile', 'w', 0, 100));
    connect(g, { node: 'r', port: 'out' }, { node: 'w', port: 'content' });
    const wrote: string[] = [];
    const got = await run(g, { show: () => undefined, readFile: async () => 'なかみ', writeFile: async (n, t) => { wrote.push(`${n}=${t}`); } });
    assert.equal(got.ok, true);
    assert.deepEqual(wrote, ['memo.txt=なかみ']);
  });
  test('写す形は Node で動く頭を持つ', () => {
    const s = exportScript(sampleHello());
    assert.match(s, /import \{ readFile, writeFile \} from 'node:fs\/promises'/);
    assert.match(s, /main\(\)/);
  });
});

describe('型でつなげるか', () => {
  test('同じ型・なんでも・数から文字はつなげる', () => {
    assert.equal(canConnect('num', 'num').ok, true);
    assert.equal(canConnect('text', 'any').ok, true);
    assert.equal(canConnect('any', 'bool').ok, true);
    assert.equal(canConnect('num', 'text').ok, true);
  });
  test('文字を数の口へは断り、わけを言う', () => {
    const got = canConnect('text', 'num');
    assert.equal(got.ok, false);
    assert.equal(got.why, '文字は数の口にはつなげません');
  });
  test('断ったときは何も変えない。入る口は一本だけ', () => {
    const g = emptyGraph();
    g.nodes.push(makeNode('text', 't'), makeNode('number', 'n'), makeNode('calc', 'c'));
    assert.equal(connect(g, { node: 't', port: 'out' }, { node: 'c', port: 'a' }).ok, false);
    assert.equal(g.links.length, 0);
    connect(g, { node: 'n', port: 'out' }, { node: 'c', port: 'a' });
    connect(g, { node: 'n', port: 'out' }, { node: 'c', port: 'a' });
    assert.equal(g.links.length, 1);
  });
  test('輪になるつなぎは断る', () => {
    const g = emptyGraph();
    g.nodes.push(makeNode('calc', 'a'), makeNode('calc', 'b'));
    assert.equal(connect(g, { node: 'a', port: 'out' }, { node: 'b', port: 'a' }).ok, true);
    const got = connect(g, { node: 'b', port: 'out' }, { node: 'a', port: 'a' });
    assert.equal(got.ok, false);
    assert.match(String(got.why), /輪/);
  });
});

describe('保存・読み直し・編集', () => {
  test('保存して読み直すと同じ文になり、同じ結果が出る', async () => {
    const text = serialize(sampleFizzBuzz());
    const { graph, problems } = parseGraph(text);
    assert.deepEqual(problems, []);
    assert.equal(serialize(graph), text);
    assert.equal(await outputOf(graph), FIZZ);
  });
  test('知らないブロックと、つなげない線は外して、何を外したかを言う', () => {
    const { graph, problems } = parseGraph(JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: 'text' }, { id: 'b', kind: 'calc' }, { id: 'x', kind: 'rocket' }], links: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'a' } }] }));
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.links.length, 0);
    assert.equal(problems.length, 2);
  });
  test('壊れた JSON は読めないと言う', () => {
    assert.match(parseGraph('{').problems[0]!, /読めませんでした/);
  });
  test('消すと線も消え、写すと中の線も写る', () => {
    const g = sampleHello();
    const made = duplicateNodes(g, ['n1', 'n2']);
    assert.equal(made.length, 2);
    assert.equal(g.links.length, 3, '中の線（n1→n2）だけ写る。外へ出る線は写さない');
    removeNodes(g, ['n2']);
    assert.ok(g.links.every((l) => l.from.node !== 'n2' && l.to.node !== 'n2'));
  });
  test('元に戻す・やり直す', () => {
    const h = makeHistory();
    h.push('A');
    h.push('B');
    assert.equal(h.undo('C'), 'B');
    assert.equal(h.undo('B'), 'A');
    assert.equal(h.redo('A'), 'B');
    assert.equal(h.canRedo, true);
  });
  test('名前で探せる', () => {
    assert.deepEqual(searchBlocks('天気').map((x) => x.kind), ['weather']);
    assert.equal(searchBlocks('').length, Object.keys(BLOCKS).length);
  });
  test('AI に渡す説明に、全部のブロックの種類が入っている', () => {
    const g = graphFormatGuide();
    for (const k of Object.keys(BLOCKS)) assert.ok(g.includes(`- ${k}（`), k);
  });
});

describe('手順の形', () => {
  test('傘の見本: 雨なら「傘を持って」、そうでなければ「傘はいらない」', async () => {
    for (const [rain, want] of [[true, '傘を持って'], [false, '傘はいらない']] as const) {
      const out: unknown[] = [];
      const got = await runWorkflow(sampleUmbrella(), { show: (v) => out.push(v), weather: async () => ({ text: 'x', rain }) });
      assert.equal(got.ok, true);
      assert.deepEqual(out, [want]);
    }
  });
  test('前の手順の出力だけを選べる', () => {
    const wf = sampleUmbrella();
    assert.deepEqual(availableOutputs(wf, 's2').map((o) => `${o.node}.${o.port}`), ['s1.text', 's1.rain']);
    assert.deepEqual(availableOutputs(wf, 's1'), []);
  });
  test('後ろの手順を指す欄は、その手順を指して断る', () => {
    const wf = emptyWorkflow();
    const a = makeStep('show', 's1');
    a.values.value = { ref: 's2', port: 'out' };
    wf.steps.push(a, makeStep('text', 's2'));
    assert.equal(compileWorkflow(wf).errors[0]?.node, 's1');
  });
  test('つなぐ形から手順の形へ、また戻しても同じ結果', async () => {
    const wf = graphToWorkflow(sampleFizzBuzz()).workflow!;
    assert.ok(wf);
    assert.equal(wf.steps.length, 1);
    assert.equal(wf.steps[0]!.kind, 'repeat');
    const out: unknown[] = [];
    await runWorkflow(wf, { show: (v) => out.push(v) });
    assert.equal(out.join(','), FIZZ);
    const back = workflowToGraph(wf).graph!;
    assert.equal(await outputOf(back), FIZZ);
  });
  test('条件の手順は、つなぐ形では表せないと言う', () => {
    const got = workflowToGraph(sampleUmbrella());
    assert.equal(got.graph, undefined);
    assert.match(String(got.why), /条件の手順/);
  });
  test('両方の形を一つのファイルに保存し、読み直せる', () => {
    const text = serializeFile(sampleHello(), sampleUmbrella(), 'flow');
    const got = parseFile(text);
    assert.equal(got.view, 'flow');
    assert.equal(got.workflow?.steps.length, 2);
    assert.equal(got.graph.nodes.length, 3);
  });
  test('毎日のきっかけは日本時間で見る', () => {
    assert.equal(dailyDue('08:00', new Date('2026-11-08T23:00:00Z')), true);
    assert.equal(dailyDue('08:00', new Date('2026-11-08T08:00:00Z')), false);
  });
});

describe('向き（表示だけ。中身は変えない）', () => {
  const pos = (g: Graph) => new Map(g.nodes.map((n) => [n.id, n]));
  for (const dir of ['ltr', 'ttb'] as const) {
    test(`${dir}: 整えると、線はすべて向きに沿って進む`, () => {
      const g = autoLayout(sampleFizzBuzz(), dir);
      const at = pos(g);
      for (const l of g.links) {
        const a = at.get(l.from.node)!;
        const b = at.get(l.to.node)!;
        if (dir === 'ltr') assert.ok(b.x > a.x, `${l.from.node}→${l.to.node} の x`);
        if (dir === 'ttb') assert.ok(b.y > a.y, `${l.from.node}→${l.to.node} の y`);
      }
    });
  }
  // 左上から右（折り返し）: 文字を読む順。同じ段なら右へ、幅に届いたら次の段の左へ
  for (const width of [1900, 900, 300]) {
    test(`wrap（幅 ${width}）: 読む順に並び、線は同じ段なら右へ、そうでなければ下の段へ進む`, () => {
      const g = autoLayout(sampleFizzBuzz(), 'wrap', { width });
      const at = pos(g);
      const order = readingOrder(g);
      const perRow = Math.max(1, Math.floor((Math.max(width, WRAP_STEP.x) - 40) / WRAP_STEP.x));
      order.forEach((n, i) => {
        if (i === 0) { assert.equal(n.x, 40); assert.equal(n.y, 40); return; }
        const prev = order[i - 1]!;
        const sameRow = n.y === prev.y && n.x > prev.x;
        const nextRow = n.y === prev.y + WRAP_STEP.y && n.x === 40;
        assert.ok(sameRow || nextRow, `${prev.id}→${n.id}: (${prev.x},${prev.y})→(${n.x},${n.y})`);
        assert.equal(sameRow, i % perRow !== 0, `${n.id} の折り返し`);
        assert.ok(n.x + 200 <= Math.max(width, WRAP_STEP.x + 40), `${n.id} が幅からはみ出す`);
      });
      for (const l of g.links) {
        const a = at.get(l.from.node)!;
        const b = at.get(l.to.node)!;
        assert.ok(b.y > a.y || (b.y === a.y && b.x > a.x), `${l.from.node}→${l.to.node} が読む順に逆らう`);
      }
    });
  }
  test('前の「左上から右下」（diag）は、左上から右（折り返し）として読む', () => {
    assert.equal(normalizeDirection('diag'), 'wrap');
    assert.equal(normalizeDirection('wrap'), 'wrap');
    assert.equal(normalizeDirection('ltr'), 'ltr');
    assert.equal(normalizeDirection('zigzag'), undefined);
    const g = autoLayout(sampleFizzBuzz(), 'diag', { width: 900 });
    const w = autoLayout(sampleFizzBuzz(), 'wrap', { width: 900 });
    assert.deepEqual(g.nodes.map((n) => [n.x, n.y]), w.nodes.map((n) => [n.x, n.y]));
  });
  test('向きを変えても、作る JavaScript は同じ', () => {
    const base = compile(sampleFizzBuzz()).code;
    for (const dir of ['ltr', 'ttb', 'wrap']) assert.equal(compile(autoLayout(sampleFizzBuzz(), dir)).code, base, dir);
  });
});

/** 文章の形で押して組むのと同じ FizzBuzz（比べて分かれる手順 when を入れ子に） */
function fizzWhen(): Workflow {
  const wf = emptyWorkflow();
  const r = makeStep('repeat', 's1');
  r.values.to = 15;
  const each = { ref: 's1', port: 'each' };
  const when = (id: string, b: number, yes: string, no: ReturnType<typeof makeStep>[]) => {
    const w = makeStep('when', id);
    Object.assign(w.values, { a: each, op: '割り切れる', b });
    const s = makeStep('show', `${id}y`);
    s.values.value = yes;
    w.yes!.push(s);
    w.no!.push(...no);
    return w;
  };
  const last = makeStep('show', 's8');
  last.values.value = each;
  r.body!.push(when('s2', 15, 'FizzBuzz', [when('s4', 3, 'Fizz', [when('s6', 5, 'Buzz', [last])])]));
  wf.steps.push(r);
  return wf;
}

describe('文章の形（手順の形と同じ中身）', () => {
  test('比べて分かれる手順（when）を入れ子にした FizzBuzz が 1〜15 を正しく出す', async () => {
    const out: unknown[] = [];
    const got = await runWorkflow(fizzWhen(), { show: (v) => out.push(v) });
    assert.equal(got.ok, true, got.message);
    assert.equal(out.join(','), FIZZ);
  });
  test('「割り切れる」は A % B === 0 になる。読み方は「で割り切れる」', () => {
    assert.match(compileWorkflow(fizzWhen()).code, /v_s1_each % 15 === 0/);
    assert.equal(COMPARE_WORDS['割り切れる'], 'で割り切れる');
    const g = emptyGraph();
    const c = makeNode('compare', 'c');
    Object.assign(c.values, { a: 9, op: '割り切れる', b: 3 });
    g.nodes.push(c);
    assert.match(compile(g).code, /9 % 3 === 0/);
  });
  test('動かすと、行ごとの値（はい・いいえの回数、最後の値）を rt.seen で受け取れる', async () => {
    const seen = new Map<string, unknown[]>();
    await runWorkflow(fizzWhen(), { show: () => undefined, seen: (id, v) => { seen.set(id, [...(seen.get(id) ?? []), v]); } });
    const s2 = seen.get('s2')!;
    assert.equal(s2.length, 15);
    assert.equal(s2.filter((v) => v === true).length, 1);
    assert.equal(seen.get('s4')!.filter((v) => v === true).length, 4);
  });
  test('保存して読み直しても文章の形のまま、同じ中身', async () => {
    const text = serializeFile(emptyGraph(), fizzWhen(), 'text');
    const got = parseFile(text);
    assert.deepEqual(got.problems, []);
    assert.equal(got.view, 'text');
    assert.deepEqual(got.workflow, fizzWhen());
    const out: unknown[] = [];
    await runWorkflow(got.workflow!, { show: (v) => out.push(v) });
    assert.equal(out.join(','), FIZZ);
  });
  test('比べて分かれる手順は、つなぐ形では表せないと言う（条件の手順と同じ）', () => {
    const got = workflowToGraph(fizzWhen());
    assert.equal(got.graph, undefined);
    assert.equal(got.node, 's2');
  });
  test('一覧ブロックは、空の欄を入れずに並べる（前は名前の無い変数を見て落ちた）', async () => {
    const g = emptyGraph();
    const l = makeNode('list', 'l');
    Object.assign(l.values, { a: 'りんご', b: '' , c: 'みかん' });
    g.nodes.push(l, makeNode('show', 's'));
    connect(g, { node: 'l', port: 'out' }, { node: 's', port: 'value' });
    const out: unknown[] = [];
    const got = await run(g, { show: (v) => out.push(v) });
    assert.equal(got.ok, true, got.message);
    assert.deepEqual(out, [['りんご', 'みかん']]);
  });
});
