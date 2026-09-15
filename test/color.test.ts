/**
 * 色の読み取りと変換。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse, toHex, toRgbString, toHslString, rgbToHsl, hslToRgb,
  findColors, contrast, readability,
} from '../src/ui/web/color-core.js';

describe('読み取り', () => {
  test('16進を読む（3桁も8桁も）', () => {
    assert.deepEqual(parse('#f00'), { r: 255, g: 0, b: 0, a: 1 });
    assert.deepEqual(parse('#ff0000'), { r: 255, g: 0, b: 0, a: 1 });
    assert.equal(parse('#ff000080')?.a.toFixed(2), '0.50');
  });

  test('rgb を読む。区切りは , でも空白でもよい', () => {
    assert.deepEqual(parse('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
    assert.deepEqual(parse('rgb(1 2 3)'), { r: 1, g: 2, b: 3, a: 1 });
    assert.equal(parse('rgba(1,2,3,0.5)')?.a, 0.5);
    assert.equal(parse('rgb(1 2 3 / 50%)')?.a, 0.5);
  });

  test('hsl を読む', () => {
    assert.deepEqual(parse('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
    assert.deepEqual(parse('hsl(120, 100%, 50%)'), { r: 0, g: 255, b: 0, a: 1 });
  });

  test('名前も読む', () => {
    assert.deepEqual(parse('red'), { r: 255, g: 0, b: 0, a: 1 });
    assert.equal(parse('  WHITE  ')?.r, 255);
  });

  test('読めないものは、読めないと返す。推測しない', () => {
    // 打ち間違いを黒として通すと、間違いに気づけない。
    for (const s of ['', 'いろ', '#12', '#xyzxyz', 'rgb(1,2)', 'hsl()', 'rgb(あ,い,う)']) {
      assert.equal(parse(s), undefined, `読めてしまっている: ${s}`);
    }
  });
});

describe('書き出し', () => {
  test('透けていないなら 8桁にしない', () => {
    assert.equal(toHex({ r: 255, g: 0, b: 0, a: 1 }), '#ff0000');
    assert.equal(toHex({ r: 255, g: 0, b: 0, a: 0.5 }).length, 9);
  });

  test('rgb と hsl の文字列を作る', () => {
    assert.equal(toRgbString({ r: 1, g: 2, b: 3, a: 1 }), 'rgb(1, 2, 3)');
    assert.match(toRgbString({ r: 1, g: 2, b: 3, a: 0.5 }), /^rgba\(/);
    assert.equal(toHslString({ r: 255, g: 0, b: 0, a: 1 }), 'hsl(0, 100%, 50%)');
  });
});

describe('往復', () => {
  test('rgb → hsl → rgb で戻ってくる', () => {
    for (const c of [
      { r: 122, g: 162, b: 247, a: 1 }, { r: 0, g: 0, b: 0, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 }, { r: 34, g: 211, b: 238, a: 1 },
    ]) {
      const back = hslToRgb(rgbToHsl(c));
      for (const k of ['r', 'g', 'b'] as const) {
        assert.ok(Math.abs(back[k] - c[k]) <= 1, `${k} がずれた: ${back[k]} vs ${c[k]}`);
      }
    }
  });

  test('灰色は色味を持たない', () => {
    assert.equal(rgbToHsl({ r: 128, g: 128, b: 128, a: 1 }).s, 0);
  });

  test('内側では丸めない。丸めると、つまみを動かすたびに色がずれる', () => {
    const hsl = rgbToHsl({ r: 122, g: 162, b: 247, a: 1 });
    // 何度往復させても、元の色から離れない。
    let rgb = { r: 122, g: 162, b: 247, a: 1 };
    for (let i = 0; i < 20; i++) rgb = hslToRgb(rgbToHsl(rgb));
    assert.deepEqual(rgb, { r: 122, g: 162, b: 247, a: 1 });
    // 見せるときには丸める。
    assert.match(toHslString({ r: 122, g: 162, b: 247, a: 1 }), /^hsl\(\d+, \d+%, \d+%\)$/);
    assert.ok(hsl.s > 0);
  });
});

describe('文の中から見つける', () => {
  test('位置つきで見つける。元の場所に重ねられるように', () => {
    const found = findColors('color: #7aa2f7; background: rgb(0 0 0);');
    assert.equal(found.length, 2);
    assert.equal(found[0]!.value, '#7aa2f7');
    assert.equal(found[0]!.start, 7);
  });

  test('色に見えるが色でないものは拾わない', () => {
    // #deadbeef は8桁として読めてしまうので、混ざる場面を確かめる
    const found = findColors('const id = "#zzz"; // #12');
    assert.equal(found.length, 0);
  });

  test('名前も拾う', () => {
    assert.equal(findColors('border: 1px solid red;')[0]?.value, 'red');
  });

  test('多すぎるときは切る', () => {
    assert.equal(findColors('#fff '.repeat(500), 10).length, 10);
  });

  test('色が無ければ空', () => {
    assert.deepEqual(findColors('const x = 1;'), []);
  });
});

describe('読めるかどうか', () => {
  test('白と黒がいちばん差がある', () => {
    const r = contrast({ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 });
    assert.equal(r, 21);
  });

  test('同じ色なら差は無い', () => {
    assert.equal(contrast({ r: 10, g: 20, b: 30, a: 1 }, { r: 10, g: 20, b: 30, a: 1 }), 1);
  });

  test('数字だけでなく、言葉にする', () => {
    // 4.7:1 と言われても判断できない。
    assert.equal(readability(21).level, 'good');
    assert.equal(readability(3.5).level, 'warn');
    assert.equal(readability(1.2).level, 'bad');
    assert.match(readability(21).label, /読める/);
  });
});

/**
 * 見本の重ね方（decorate）は、ここでは確かめていない。
 *
 * TreeWalker も断片も、いまの DOM の作り物には無い。
 * **自分の実装に合わせた作り物を書いて通しても、通ったことにはならない。**
 * 重ねる場所を決めているのは findColors で、そちらは上で確かめてある。
 * DOM を触る部分は薄いので、実物のブラウザで一度見るまでは
 * 「確かめていない」と書いておく。
 */
