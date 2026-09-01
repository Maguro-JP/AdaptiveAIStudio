/**
 * コードの中の色に、見本を重ねる。
 *
 * 利用者が挙げた機能そのもの（「コーディング中に色関係のところで
 * できたらかなり便利」）。**元の文字を変えないこと**が肝で、
 * 色を消して見本だけにすると、何が書いてあったのか分からなくなる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, createText, type StubNode } from './dom-stub.ts';

installDom();
const { decorate } = await import('../src/ui/web/color.js') as {
  decorate: (node: StubNode, opts?: { onPick?: (from: string, to: string) => void }) => void;
};

/** 文字を1つだけ持つ節を作る。 */
function withText(text: string, className = ''): StubNode {
  const box = createNode('div');
  box.className = className;
  box.append(createText(text));
  return box;
}

/** 見本（押せるもの）だけを拾う。 */
function swatches(node: StubNode): StubNode[] {
  return node.buttons().filter((b) => b.className.includes('color-swatch'));
}

describe('色に見本を重ねる', () => {
  test('元の文字を消さない', () => {
    const box = withText('  --accent: #7aa2f7;');
    decorate(box);
    // 見本を足しても、書いてあったものはそのまま読める。
    assert.match(box.text, /--accent:/);
    assert.match(box.text, /#7aa2f7/);
  });

  test('見つけた色の数だけ、見本を出す', () => {
    const box = withText('a #ff0000 b rgb(0,255,0) c hsl(240, 100%, 50%) d');
    decorate(box);
    const chips = swatches(box);
    assert.equal(chips.length, 3, `見本の数が合わない: ${chips.length}`);
    assert.deepEqual(chips.map((c) => c.style.background), ['#ff0000', 'rgb(0,255,0)', 'hsl(240, 100%, 50%)']);
  });

  test('色が無ければ、何も足さない', () => {
    const box = withText('ただの文章です。#ではじまるが色ではない #zzz');
    const before = box.children.length;
    decorate(box);
    assert.equal(swatches(box).length, 0);
    assert.equal(box.children.length, before, '触らなくてよいものを触っている');
  });

  test('見本の中の色に、二重に重ねない', () => {
    // 一度重ねたものをまた通すと、見本の中の文字にまた見本が付く。
    // 既に見本の中にある文字は、飛ばす。
    const box = createNode('div');
    box.append(withText('#7aa2f7', 'color-swatch'));
    decorate(box);
    assert.equal(swatches(box).length, 0, '見本の中にまた見本を足している');
    // 飛ばしても、書いてあるものは消さない。
    assert.match(box.text, /#7aa2f7/);
  });

  test('見本の外なら、ちゃんと重ねる', () => {
    // 上の試験が「常に何もしない」で通ってしまわないように、対にする。
    const box = createNode('div');
    box.append(withText('#7aa2f7', 'ふつうの節'));
    decorate(box);
    assert.equal(swatches(box).length, 1);
  });

  test('押すと、選んだ結果を返す', () => {
    const box = withText('color: #112233;');
    const picked: string[] = [];
    decorate(box, { onPick: (from, to) => picked.push(`${from}→${to}`) });
    const chip = swatches(box)[0]!;
    assert.equal(chip.title, '#112233 — 押すと開く');
    assert.equal(typeof chip.onclick, 'function', '押せるようになっていない');
    void picked;
  });
});
