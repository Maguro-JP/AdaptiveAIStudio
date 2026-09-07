/**
 * 前置きを予算に収める。
 *
 * ここで見るのは、**並べる場所と、残す優先が、別々になっている**こと。
 * 直す前は同じもので、捨てる順を配列の添字で手書きしていた
 * （`const drop = [4, 1, 3]`）。並べ替えれば黙って違うものを指す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitParts, type Part } from '../src/core/prompt-budget.ts';

/** 一文字＝一つ。数え方の細かさは、ここで見たいことと関係が無い。 */
const count = (t: string) => t.length;

/** 予算をいくら渡されても、決まった長さを返す部品。 */
function fixed(name: string, priority: number, text: string, required = false): Part {
  return { name, priority, required, render: () => text };
}

describe('優先の低い方から落とす', () => {
  test('**入るなら、全部そのまま出す**', async () => {
    const { text, dropped } = await fitParts([
      fixed('あ', 10, 'AAA'), fixed('い', 20, 'BBB'),
    ], 100, count);
    assert.equal(text, 'AAA\n\nBBB');
    assert.deepEqual(dropped, []);
  });

  test('入らないときに落ちるのは、優先の低い方', async () => {
    const { text, dropped } = await fitParts([
      fixed('のこす', 90, 'AAAAA'), fixed('おとす', 10, 'BBBBB'),
    ], 7, count);
    assert.deepEqual(dropped, ['おとす']);
    assert.equal(text, 'AAAAA');
  });

  test('**並べ替えても、落ちるものは変わらない**', async () => {
    const a = fixed('のこす', 90, 'AAAAA');
    const b = fixed('おとす', 10, 'BBBBB');
    const one = await fitParts([a, b], 7, count);
    const two = await fitParts([b, a], 7, count);
    assert.deepEqual(one.dropped, ['おとす']);
    assert.deepEqual(two.dropped, ['おとす'],
      '並べ替えたら、違うものを落としている（添字で書いていたときの壊れ方）');
  });

  test('並べる場所は、書いた順のまま（対）', async () => {
    // 優先は あ が低いが、**前に書いてあるので前に出る。**
    const { text } = await fitParts([
      fixed('あ', 10, 'AAA'), fixed('い', 90, 'BBB'),
    ], 100, count);
    assert.equal(text, 'AAA\n\nBBB', '優先の順に並べてしまっている');
  });

  test('落とさないと言ったものは、超えていても残す', async () => {
    const { text, dropped } = await fitParts([
      fixed('きまり', 100, 'AAAAAAAAAA', true),
    ], 3, count);
    assert.equal(text, 'AAAAAAAAAA');
    assert.deepEqual(dropped, []);
  });

  test('**足りなくなるまで落とす。落とし切らない**', async () => {
    const { text, dropped } = await fitParts([
      fixed('のこる', 90, 'AAAAA'), fixed('おとす1', 20, 'BBBBB'), fixed('おとす2', 10, 'CCCCC'),
    ], 12, count);
    // AAAAA(5) + \n\n(2) + BBBBB(5) = 12 で収まる。C だけ落ちる。
    assert.deepEqual(dropped, ['おとす2']);
    assert.equal(text, 'AAAAA\n\nBBBBB');
  });
});

describe('予算は、優先の高い方から渡す', () => {
  test('**先に取るのは、優先の高い方**', async () => {
    const got: Record<string, number> = {};
    const spy = (name: string, priority: number, take: number): Part => ({
      name,
      priority,
      render: (left) => { got[name] = left; return 'x'.repeat(take); },
    });
    // 並びは あ → い だが、優先は い の方が高い。
    await fitParts([spy('あ', 10, 3), spy('い', 90, 4)], 100, count);
    assert.equal(got['い'], 100, '優先の高い方に、まず全部の予算を渡していない');
    assert.equal(got['あ'], 96, '先に取られた分が、次に渡っていない');
  });

  test('使い切ったら、次には 0 を渡す（切り詰めるのは部品の仕事）', async () => {
    let seen = -1;
    await fitParts([
      fixed('たくさん', 90, 'x'.repeat(50)),
      { name: 'あと', priority: 10, render: (left) => { seen = left; return ''; } },
    ], 20, count);
    assert.equal(seen, 0);
  });
});

describe('区切りの分も数える', () => {
  /**
   * 見出しや部品の間の空行は、中身の予算に入っていない。一つずつは小さいが、
   * 足すと予算を超える。**「だいたい収まる」では狭い窓に効かない。**
   */
  test('**間の空行で溢れる分も、落として合わせる**', async () => {
    // 中身は 5 + 5 = 10 で予算 11 に収まるが、間の空行 2 を足すと 12 で超える。
    const { text, dropped } = await fitParts([
      fixed('のこる', 90, 'AAAAA'), fixed('おとす', 10, 'BBBBB'),
    ], 11, count);
    assert.deepEqual(dropped, ['おとす'], '間の空行を数えていない');
    assert.equal(count(text), 5);
  });
});
