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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { notChecked, describeNotChecked, reportEnd } from '../scripts/not-checked.mjs';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { treeMoved } from '../scripts/pushed-tree.mjs';

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

describe('どの木の話かを、出力に書く', () => {
  test('**commit していない直しがある木で確かめたなら、そう言う**', () => {
    /*
     * `通りました（abc1234）` とだけ出すと、受け取った側はその commit を
     * 確かめたものとして扱う。汚れた木で回したなら、その sha そのものの
     * 話ではない。**黙って sha だけ出さない。**
     */
    const text = describeNotChecked(ran, 'abc1234', [' M src/a.ts', '?? src/b.ts']) as string;
    assert.match(text, /commit していない直しが 2 件/, '汚れていたことを言っていない');
    assert.match(text, /src\/a\.ts/, '何が汚れていたかを言っていない');
    assert.match(text, /そのものではありません/, 'sha の話ではないと言っていない');
    // 一覧そのものは、これまで通り出る。
    assert.match(text, /ここで確かめていないこと/);
  });

  test('綺麗な木なら、その行は出さない（対）', () => {
    const text = describeNotChecked(ran, 'abc1234', []) as string;
    assert.doesNotMatch(text, /commit していない直し/, '綺麗なのに汚れていると言っている');
  });

  test('多いときは切る。全部並べると一覧が流れる', () => {
    const dirty = Array.from({ length: 30 }, (_, i) => ` M src/f${i}.ts`);
    const text = describeNotChecked(ran, 'abc1234', dirty) as string;
    assert.match(text, /ほか 20 件/);
  });

  test('**木が動いていたら、通ったと言わない**', () => {
    // 実際に起きたずれ方。始めの木と終わりの木が違うなら、結果はどちらの話でもない。
    const end = reportEnd({
      began: { head: 'a'.repeat(40), dirty: [] },
      ended: { head: 'b'.repeat(40), dirty: [] },
      how: ran, moved: treeMoved,
    }) as { code: number; text: string };
    assert.equal(end.code, 1, '通したことになっている');
    assert.match(end.text, /動きました/);
    assert.doesNotMatch(end.text, /通りました/, '動いたのに通ったと言っている');
  });

  test('動いていなければ、始めの版で通ったと言う（対）', () => {
    const began = { head: 'abc1234def', dirty: [' M src/a.ts'] };
    const end = reportEnd({ began, ended: began, how: ran, moved: treeMoved }) as
      { code: number; text: string };
    assert.equal(end.code, 0, `止まっている: ${end.text}`);
    assert.match(end.text, /通りました（abc1234）/, '始めの版が出ていない');
    assert.match(end.text, /commit していない直しが 1 件/, '汚れていたことを落としている');
  });

  test('汚れの数が同じでも、中身が変われば動いたと見る', () => {
    /*
     * 一つ片付いて一つ汚れると、数は同じまま木が変わる。数で見ていると
     * 「変わっていない」と読む。
     */
    const end = reportEnd({
      began: { head: 'a'.repeat(40), dirty: [' M src/a.ts'] },
      ended: { head: 'a'.repeat(40), dirty: [' M src/b.ts'] },
      how: ran, moved: treeMoved,
    }) as { code: number; text: string };
    assert.equal(end.code, 1, '同じ木だと読んでいる');
    assert.match(end.text, /増えました/);
  });

  test('**始めに控えて、終わりに突き合わせている**', async () => {
    /*
     * 版を終わりに読むと、途中で commit したときに確かめていない版が書かれる。
     * 直したのは呼ぶ順番なので、**順番そのものを見る**（関数を足しても、
     * 呼ぶ場所が後ろなら意味が無い）。
     */
    const src = await readFile(
      join(import.meta.dirname, '..', 'scripts', 'check.mjs'), 'utf8');
    const began = src.indexOf('const began = lookTreeOrEmpty(root)');
    // 最初の段は `--noEmit` で指す。言葉の網に当たらない文字を選ぶ。
    const first = src.indexOf("'--noEmit'");
    const judge = src.indexOf('moved: treeMoved,');
    const said = src.indexOf('process.exit(end.code)');
    assert.ok(began >= 0, '始めに控えていない');
    assert.ok(first >= 0 && began < first, '最初の段より後で控えている');
    assert.ok(judge > first, '突き合わせが、段より前にある');
    assert.ok(judge < said, '突き合わせが、通りましたと言った後にある');
    // 終わりに HEAD を読み直す形へ戻っていないか。
    assert.doesNotMatch(src, /rev-parse', '--short', 'HEAD'/,
      '終わりに版を読み直す形が残っています');
  });
});
