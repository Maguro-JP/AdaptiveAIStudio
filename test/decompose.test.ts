/**
 * 依頼を、歩ける大きさの段に割る。
 *
 * **モデルに割らせる。ただし信用しない。**
 * 小さいモデルは平気で壊れたものを返す。番号だけ、空の行、前置き、
 * 丸ごと作文。読めないなら**割らないで進む**
 * （割れないことは、進めない理由にならない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readSteps, stepPrompt } from '../src/agent/decompose.ts';

describe('返ってきたものから、段を拾う', () => {
  test('素直な形', () => {
    assert.deepEqual(readSteps('src/a.ts を読む\n型を string に直す\nnpm test を走らせる', 6), [
      'src/a.ts を読む', '型を string に直す', 'npm test を走らせる',
    ]);
  });

  test('番号や記号は落とす（付けるなと言っても付けてくる）', () => {
    const got = readSteps('1. src/a.ts を読む\n2) 型を直す\n- npm test を走らせる\n・報告する', 6);
    assert.deepEqual(got, ['src/a.ts を読む', '型を直す', 'npm test を走らせる', '報告する']);
  });

  test('前置きと見出しは落とす', () => {
    const got = readSteps('以下の手順で進めます。\n\n## 段取り\nsrc/a.ts を読む\n型を直す', 6);
    assert.deepEqual(got, ['src/a.ts を読む', '型を直す']);
  });

  test('終わりの合図が混ざっても、段にしない', () => {
    const got = readSteps('src/a.ts を読む\n型を直す\nTASK_DONE', 6);
    assert.deepEqual(got, ['src/a.ts を読む', '型を直す']);
  });

  test('同じ段を二度出してきたら、一度だけ', () => {
    assert.deepEqual(readSteps('src/a.ts を読む\nsrc/a.ts を読む\n型を直す', 6),
      ['src/a.ts を読む', '型を直す']);
  });

  test('多すぎるときは、割らずに進ませる（頭から拾って残りを捨てると、捨てた段を行わないまま済んだにする）', () => {
    assert.deepEqual(readSteps('あいうえお\nかきくけこ\nさしすせそ\nたちつてと', 2), []);
    assert.equal(readSteps('あいうえお\nかきくけこ', 2).length, 2, 'ちょうどの数は割る');
  });

  test('1段しか拾えないなら、割れていないのと同じ', () => {
    // 割ったつもりで丸ごと一段、が起きる。それは割っていない。
    assert.deepEqual(readSteps('src を全部きれいに直す', 6), []);
    assert.deepEqual(readSteps('', 6), []);
  });

  test('丸ごと作文で返してきたら、拾わない', () => {
    // 長い一段は、段ではない。渡しても通らない。
    const essay = 'この依頼はとても複雑なので、'.repeat(20);
    assert.deepEqual(readSteps(essay, 6), []);
  });
});

describe('一段の頼み方', () => {
  test('その段だけを見て実行できる形にする', () => {
    const p = stepPrompt('src を直して', 'src/a.ts を読む', 1, 3);
    assert.ok(p.includes('src を直して'), '元の依頼が消えている');
    assert.ok(p.includes('src/a.ts を読む'));
    assert.ok(p.includes('1/3'), '何段目かが分からない');
    // ほかの段へ手を出させない。出させると、段に割った意味が無くなる。
    assert.ok(p.includes('ほかの段には手を出さない'), p);
  });
});
