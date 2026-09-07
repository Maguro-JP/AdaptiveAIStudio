/**
 * ローカルとクラウドの間で、作業中のものを渡す。
 *
 * クラウドで開発すると Linux の容れ物、ローカルで開発すると Windows。
 * **同時には触れないし、片方の作業はもう片方から見えない。**
 * 渡す道が無いので、同じ作業を二度やることになる。
 *
 * git はもともとこれをやるための物なので、**ローカルを枝として扱う**。
 * ここで確かめるのは、その決め方（枝の名前・どれを取り込むか・止める条件）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { branchFor, pickToTake, whyNotSend, whyNotTake, jst } from '../scripts/handoff-plan.mjs';

describe('機械ごとの枝を決める', () => {
  test('走らせる場所と機械の名前から作る', () => {
    assert.equal(branchFor({ platform: 'win32', hostname: 'MAGURO-PC' }), 'wip/win32-maguro-pc');
    assert.equal(branchFor({ platform: 'linux', hostname: 'abc123' }), 'wip/linux-abc123');
  });

  test('**git の枝に使えない字を、そのまま渡さない**', () => {
    // 機械の名前には空白も全角も入る。渡すと push がそこで落ちる。
    const got = branchFor({ platform: 'win32', hostname: 'マグロ の PC' }) as string;
    assert.match(got, /^wip\/[a-z0-9._-]+$/, `枝に使えない字が残っている: ${got}`);
  });

  test('名前が全部落ちても、必ず何か返す（対）', () => {
    // 名前が決まらないと渡す先が決まらない。空の枝名で push しない。
    const got = branchFor({ platform: '', hostname: '日本語だけ' }) as string;
    assert.match(got, /^wip\/[a-z0-9._-]+$/, got);
  });

  test('自分で名前を付けられる', () => {
    assert.equal(
      branchFor({ platform: 'win32', hostname: 'x', env: { AAS_HANDOFF_NAME: 'jitaku' } }),
      'wip/jitaku',
    );
  });
});

describe('どれを取り込むか', () => {
  const b = (name: string) => ({ name, at: '2026-09-07T00:00:00Z' });

  test('一つしか無ければ、それ', () => {
    const got = pickToTake({ branches: [b('wip/linux-a'), b('wip/win32-b')], mine: 'wip/win32-b' });
    assert.deepEqual(got, { ok: true, take: 'wip/linux-a' });
  });

  test('**自分の枝は取り込まない**', () => {
    const got = pickToTake({ branches: [b('wip/win32-b')], mine: 'wip/win32-b' });
    assert.equal(got.ok, false, '自分の枝を取り込もうとしている');
  });

  test('**複数あるなら、こちらで決めない**', () => {
    // 選ぶと、意図しない方を取り込んで作業が消える。
    const got = pickToTake({
      branches: [b('wip/linux-a'), b('wip/win32-b'), b('wip/darwin-c')], mine: 'wip/win32-b',
    });
    assert.equal(got.ok, false);
    assert.deepEqual(got.choices.sort(), ['wip/darwin-c', 'wip/linux-a']);
  });

  test('名指しされたら、それ（対）', () => {
    const got = pickToTake({
      branches: [b('wip/linux-a'), b('wip/win32-b'), b('wip/darwin-c')],
      mine: 'wip/win32-b', want: 'linux-a',
    });
    assert.deepEqual(got, { ok: true, take: 'wip/linux-a' });
  });

  test('名指しされたものが無ければ、選べるものを見せる', () => {
    const got = pickToTake({ branches: [b('wip/linux-a')], mine: 'wip/win32-b', want: 'zzz' });
    assert.equal(got.ok, false);
    assert.deepEqual(got.choices, ['wip/linux-a']);
  });
});

describe('止める条件', () => {
  test('渡すものが無ければ、送らない', () => {
    assert.ok(whyNotSend({ branch: 'main', dirty: false, ahead: 0 }));
    assert.equal(whyNotSend({ branch: 'main', dirty: true, ahead: 0 }), undefined);
    assert.equal(whyNotSend({ branch: 'main', dirty: false, ahead: 2 }), undefined);
  });

  test('**書きかけの上に、取り込ませない**', () => {
    // 取り込むと衝突して、どちらが自分の書いたものか分からなくなる。
    const why = whyNotTake({ dirty: true }) as string;
    assert.ok(why, '書きかけなのに通している');
    assert.match(why, /コミット|片づけ/, '次の一手を言っていない');
    assert.equal(whyNotTake({ dirty: false }), undefined);
  });
});

describe('見せるときは JST', () => {
  test('UTC を JST に直す', () => {
    // 2026-09-07 20:00 UTC は、JST では翌日の 05:00。
    assert.equal(jst('2026-09-07T20:00:00Z'), '2026-09-08 05:00 JST');
  });

  test('読めない値は、そのまま返す（落とさない）', () => {
    assert.equal(jst('なにこれ'), 'なにこれ');
  });
});
