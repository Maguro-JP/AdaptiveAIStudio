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
import {
  senseDispleasure, DISPLEASURE_LABEL, DISPLEASURE_RULE, lessonFrom,
  understandPrompt, parseUnderstanding, lessonFromUnderstanding,
} from '../src/memory/displeasure.ts';
import { Memory, formatRecall } from '../src/memory/memory.ts';
import { BUILTIN_LESSONS, lessonLine } from '../src/memory/builtin-lessons.ts';

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
      title: '言い方や中身が不快だった（OFFENSIVE）',
      // **言われた言葉は残さない。**残すのは、次からどうするか。
      detail: lessonFrom('OFFENSIVE', '使った道具: write_file / 確かめていない'),
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

  test('**言われた言葉は出さない。**出すのは、次からどうするか', () => {
    // 原文を溜めるのは記録であって学びではない。しかも、自分の不満を集めた
    // 覚え書きを持たれて気分の良い相手はいない（実際に言われた）。
    const m = withHate();
    const text = formatRecall(m.recall('なんでもいい'));
    assert.match(text, /相手の言葉づかいに合わせ/, text.slice(0, 200));
    assert.match(text, /このとき: 使った道具/, '何をしていたときかが分からない');
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

describe('記録ではなく、学びにする', () => {
  test('符丁のどれにも、次からどうするかが書いてある', () => {
    for (const code of Object.keys(DISPLEASURE_LABEL) as (keyof typeof DISPLEASURE_LABEL)[]) {
      const rule = DISPLEASURE_RULE[code];
      assert.ok(rule && rule.length > 10, `${code} に、次からどうするかが無い`);
    }
  });

  test('直前に何をしていたかが添う（符丁だけだと、次の手が変わらない）', () => {
    const got = lessonFrom('BROKEN', '使った道具: write_file / 確かめていない');
    assert.match(got, /渡す前に、こちらで動かして確かめる/);
    assert.match(got, /このとき: 使った道具: write_file/);
  });

  test('**決め文句のままなら、未消化と分かる印を付ける**', () => {
    // 決め文句を並べるのは、原文を並べるのと同じで記録にしかならない。
    // 考えられなかったことを、考えた顔で残さない。
    assert.match(lessonFrom('OFFENSIVE'), /未消化/);
  });

  test('何をしていたか分からないときは、そこを足さない（作り話をしない）', () => {
    const got = lessonFrom('BROKEN');
    assert.match(got, new RegExp(DISPLEASURE_RULE.BROKEN));
    assert.doesNotMatch(got, /このとき/);
  });
});

/**
 * 何故そう言われたのかを、その場で考える。
 *
 * 原文をそのまま残すのをやめて、符丁ごとの決め文句に置き換えた。
 * **それも同じことだった。**言われた言葉を決まり文句へ差し替えただけで、
 * 何が嫌だったのかは同じように消えている（そう指摘された）。
 * 意味と意図は、その場で考えるしかない。
 */
describe('意味を汲む', () => {
  test('問いに、こちらのしたことと、返し方の形が入る', () => {
    const q = understandPrompt('配布物って気持ち悪いから言わないで', '使った道具: write_file');
    assert.match(q, /配布物って気持ち悪い/, '元の言葉を渡していない');
    assert.match(q, /使った道具: write_file/, 'こちらが何をしたかを渡していない');
    // 語形の変わらない印で返させる。日本語で返させて取り違えた前科がある。
    for (const key of ['WHAT', 'WHY', 'NEXT']) assert.match(q, new RegExp(key));
  });

  test('分からないときは、分からないと渡す（作り話をさせない）', () => {
    assert.match(understandPrompt('動かない'), /直前にこちらがしたこと: 分かりません/);
  });

  test('三行を受け取る', () => {
    const got = parseUnderstanding([
      'WHAT: 利用者が使っていない言い換えを持ち出した',
      'WHY: 自分の言葉を否定されたように感じる',
      'NEXT: 相手が使っている語のまま呼ぶ',
    ].join('\n'));
    assert.equal(got?.what, '利用者が使っていない言い換えを持ち出した');
    assert.equal(got?.next, '相手が使っている語のまま呼ぶ');
  });

  test('前置きが混ざっていても拾う（小さいモデルは必ず何か書く）', () => {
    const got = parseUnderstanding('分かりました。\n\nWHAT: 確かめずに完了と言った\nNEXT: 動かしてから言う\n');
    assert.equal(got?.what, '確かめずに完了と言った');
    assert.match(got?.why ?? '', /理由まで書かれていません/);
  });

  test('**足りないものは、埋めない**（考えていないのに考えた顔にしない）', () => {
    assert.equal(parseUnderstanding('WHY: なんとなく'), undefined);
    assert.equal(parseUnderstanding('よく分かりません'), undefined);
    assert.equal(parseUnderstanding(''), undefined);
  });

  test('覚えの一行に、何が・なぜ・次からが入る', () => {
    const line = lessonFromUnderstanding({
      what: '確かめずに完了と言った', why: '直っていないものを渡されると、確認の手間が相手へ回る',
      next: '動かしてから言う',
    }, '使った道具: write_file / 確かめていない');
    assert.match(line, /確かめずに完了と言った/);
    assert.match(line, /確認の手間が相手へ回る/);
    assert.match(line, /次から: 動かしてから言う/);
    assert.match(line, /このとき: 使った道具/);
    assert.doesNotMatch(line, /未消化/);
  });
});

/**
 * 最初から持っている「二度としないこと」。
 *
 * ここまで利用者が指摘してきたことを、製品の側に入れておく。
 * **入れた直後の何も知らない状態から、同じ地雷を踏み直させない。**
 */
describe('最初から持っている', () => {
  test('入れると、二度としないことが載っている', () => {
    const m = new Memory();
    const added = m.seedLessons();
    assert.ok(added >= 10, `少なすぎる: ${added}`);
    assert.equal(m.all().every((e) => e.kind === 'displeasure'), true);
  });

  test('二度入れても、増えない（覚え直したものを潰さない）', () => {
    const m = new Memory();
    m.seedLessons();
    const size = m.size;
    assert.equal(m.seedLessons(), 0);
    assert.equal(m.size, size);
  });

  test('話題に関係なく、最初から出てくる', () => {
    const m = new Memory();
    m.seedLessons();
    const text = formatRecall(m.recall('MCP の繋ぎ先を増やす'));
    assert.match(text, /^二度としないこと/);
    assert.match(text, /確かめていないときは、確かめていないと書く/);
  });

  test('どれも、何が・なぜ・次からが揃っている', () => {
    for (const l of BUILTIN_LESSONS) {
      const line = lessonLine(l);
      assert.match(line, /— .+ \/ 次から: /, `形が揃っていない: ${l.title}`);
      assert.ok(l.why.length > 10, `なぜ困るのかが薄い: ${l.title}`);
    }
  });

  test('**こちらの行いとして書く**（相手の感情の記録にしない）', () => {
    // 「利用者が怒った」と書くと、それは相手の不満の記録になる。
    // 書くのは、こちらが何をしたか。直せるのはこちらの手だけ。
    for (const l of BUILTIN_LESSONS) {
      assert.doesNotMatch(l.what, /利用者(が|は)[^。]*(怒|不満|不快|嫌|指摘)/,
        `相手の反応を書いている: ${l.title} — ${l.what}`);
      // 次の手は、悪かったことの言い直しでは意味がない。
      // 「〜しない」だけでも、次に何をするかが決まらない。
      assert.ok(l.next.length >= 12, `次の手が薄い: ${l.title}`);
      assert.notEqual(l.next, l.what);
      assert.ok(!l.what.includes(l.next), `次の手が、悪かったことの言い直しになっている: ${l.title}`);
    }
  });
});
