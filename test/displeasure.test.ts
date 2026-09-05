/**
 * 不快から学ぶ。
 *
 * **失敗から学ぶほうが効く。**うまくいった手を覚えると出来ることが増えるが、
 * 「その手しか取らない」ようにもなる。嫌がられたことを覚えると、
 * 出来ることは減らずに、踏む地雷だけが減る。
 *
 * ここで見るのは三つ。
 *   1. 拾えること。そして**普通の依頼まで拾わない**こと
 *   2. **話題が違っても思い出す**こと（語の重なりで引かない）
 *   3. **刈られない**こと
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { senseDispleasure, DISPLEASURE_LABEL } from '../src/memory/displeasure.ts';
import { Memory, formatRecall } from '../src/memory/memory.ts';

describe('拾う', () => {
  test('実際に言われたものを拾う', () => {
    const cases: [string, string][] = [
      ['日本語でって言ってるよね 圧縮する度にそれ止めてもらえるか?', 'REPEATED'],
      ['また障害発生してる? ちゃんと開発進めて欲しいんだけど', 'REPEATED'],
      ['配布物って気持ち悪いから言わないで', 'OFFENSIVE'],
      ['動くって言ったよな? 起動できるって意味じゃねぇぞ?', 'REPEATED'],
      ['結局止まってんじゃん', 'STALLED'],
      ['そろそろ真面目に開発してくれ', 'ANGRY'],
      ['USB を挿すのはやめて', 'STOP'],
      ['帰って試したら粗末な出来でした', 'BROKEN'],
    ];
    for (const [said, want] of cases) {
      const got = senseDispleasure(said);
      assert.equal(got?.code, want, `拾えていない: ${said} → ${got?.code ?? 'なし'}`);
    }
  });

  test('**普通の依頼は拾わない**（拾いすぎると、どれも効かなくなる）', () => {
    for (const said of [
      'レイアウトの自由度を上げて',
      'MCPちゃんと整ってる?',
      'Releasesしておいて',
      'nodeでもpythonでもいいけど、ちゃんと動く物を作ってくれ',
      'src/a.ts を読んで、テストを足して',
      '使えば使うほど賢くなる設計にしてね',
    ]) {
      const got = senseDispleasure(said);
      assert.equal(got, undefined, `普通の依頼を不快として拾った: ${said} → ${got?.code}`);
    }
  });

  test('空は拾わない', () => {
    assert.equal(senseDispleasure(''), undefined);
    assert.equal(senseDispleasure('   '), undefined);
  });

  test('符丁は、語形が変わらないもので持つ', () => {
    // 日本語で返させると「通すべきではない」を「通す」と読む、を実際にやった。
    for (const code of Object.keys(DISPLEASURE_LABEL)) {
      assert.match(code, /^[A-Z_]+$/);
    }
  });
});

describe('思い出す', () => {
  function withHate(): Memory {
    const m = new Memory();
    m.remember({
      kind: 'displeasure',
      title: '言い方が不快だった（OFFENSIVE）',
      detail: '配布物って気持ち悪いから言わないで',
      tags: ['OFFENSIVE'],
    });
    m.remember({ kind: 'fact', title: '設定は config.ts', detail: 'config.ts に書く' });
    return m;
  }

  test('**話題が違っても出る**（語が一つも重ならなくても）', () => {
    const m = withHate();
    const got = m.recall('MCP の繋ぎ先を増やしたい');
    assert.ok(got.some((e) => e.kind === 'displeasure'), '話題が違うと出てこない');
  });

  test('限度に数えない（他を押しのけない）', () => {
    const m = withHate();
    for (let i = 0; i < 20; i += 1) m.remember({ kind: 'fact', title: `設定の話${i}`, detail: '設定' });
    const got = m.recall('設定', { limit: 3 });
    assert.ok(got.some((e) => e.kind === 'displeasure'));
    assert.equal(got.filter((e) => e.kind !== 'displeasure').length, 3);
  });

  test('いちばん先に出す（後ろだと押し流される）', () => {
    const m = withHate();
    const text = formatRecall(m.recall('設定'));
    assert.match(text, /^二度としないこと/, text.slice(0, 120));
    assert.ok(text.indexOf('二度としないこと') < text.indexOf('これまでに分かっていること'));
  });

  test('利用者の言葉が、そのまま残っている', () => {
    const m = withHate();
    const text = formatRecall(m.recall('なんでもいい'));
    assert.match(text, /配布物って気持ち悪いから言わないで/);
  });
});

describe('忘れない', () => {
  test('**刈っても残る**（忘れた瞬間に、同じ地雷を踏む）', () => {
    const m = new Memory();
    m.remember({ kind: 'displeasure', title: '同じことを言わせた（REPEATED）', detail: '何度も言わせるな' });
    for (let i = 0; i < 50; i += 1) m.remember({ kind: 'fact', title: `埋め草${i}`, detail: 'どうでもよい' });
    m.compact({ max: 5 });
    assert.ok(m.all().some((e) => e.kind === 'displeasure'), '嫌がられたことを刈った');
  });

  test('同じことを繰り返したら、確度が上がる（回数が見える）', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'displeasure', title: '同じことを言わせた（REPEATED）', detail: '言ったよね' });
    const b = m.remember({ kind: 'displeasure', title: '同じことを言わせた（REPEATED）', detail: 'また言わせた' });
    assert.equal(a.entry.id, b.entry.id);
    assert.equal(b.reinforced, true);
    assert.equal(b.entry.confirms, 2);
  });
});
