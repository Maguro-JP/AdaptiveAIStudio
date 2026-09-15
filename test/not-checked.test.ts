/**
 * 通ったときに、確かめていないことを言う。
 *
 * `npm run check` は「緑」とだけ出していた。緑が意味しているのは
 * 「この機械で・乱数の重みの模型で・Chromium で押した範囲」なのに、
 * 受け取る側にはそれが見えない。**動くと読める。**
 * Windows で一度も動かしていないものを「確認しました」と出し続けた。
 *
 * 文章で気をつけても、次に書くときには戻る。**`npm run check` の側に言わせる。**
 * だからこれは、文章ではなく検査で止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { notChecked, describeNotChecked } from '../scripts/not-checked.mjs';

const ran = { platform: 'linux', sweep: 'ran', realModel: true };

describe('確かめていないことを、必ず言う', () => {
  test('**何をどう走らせても、一つも言わない、が無い**', () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      for (const sweep of ['ran', 'ブラウザがありません']) {
        for (const realModel of [true, false]) {
          const said = notChecked({ platform, sweep, realModel }) as string[];
          assert.ok(said.length > 0, `黙っている: ${platform}/${sweep}/${realModel}`);
        }
      }
    }
  });

  test('**Windows で走らせていないなら、そう言う**', () => {
    const said = (notChecked(ran) as string[]).join('\n');
    assert.match(said, /Windows/, 'Windows を確かめていないのに、言っていない');
    assert.match(said, /linux/, 'どこで走らせたかを言っていない');
  });

  test('Windows で走らせたなら、その行は出さない（対）', () => {
    const said = (notChecked({ ...ran, platform: 'win32' }) as string[]).join('\n');
    assert.doesNotMatch(said, /配る先は Windows なので/,
      'Windows で走らせたのに、未確認だと言っている');
  });

  test('**押して回っていないなら、飛ばした理由まで言う**', () => {
    const said = (notChecked({ ...ran, sweep: 'ブラウザがありません' }) as string[]).join('\n');
    assert.match(said, /押して回っていません/);
    assert.match(said, /ブラウザがありません/, '飛ばした理由を落としている');
  });

  test('押して回ったなら、どこで押したかを言う（対）', () => {
    const said = (notChecked(ran) as string[]).join('\n');
    assert.match(said, /この機械の Chromium だけ/);
  });

  test('模型で通しただけ、と言う', () => {
    // 「本物のモデルで通りました」は、道が繋がっていることしか言っていない。
    const said = (notChecked(ran) as string[]).join('\n');
    assert.match(said, /乱数の重みの模型/, '本物のモデルで確かめたように読める');
  });

  test('**配る形は、いつでも未確認と言う**', () => {
    // bundle も setup.exe も、ここでは一度も組まれない。
    for (const platform of ['linux', 'win32']) {
      const said = (notChecked({ ...ran, platform }) as string[]).join('\n');
      assert.match(said, /bundle と setup\.exe/, `${platform} で言っていない`);
      assert.match(said, /社用PC/, `${platform} で言っていない`);
    }
  });

  test('報告に、そのまま写せる形で出る', () => {
    const text = describeNotChecked(ran, 'abc1234') as string;
    assert.match(text, /通りました（abc1234）/, '版が出ていない');
    assert.match(text, /ここで確かめていないこと/);
    assert.match(text, /この一覧ごと写してください/);
  });
});
