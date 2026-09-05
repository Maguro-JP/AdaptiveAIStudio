/**
 * 使うほど賢くなるか。
 *
 * 記憶は、放っておくと**溜まるほど雑音になる**。
 * 外れた覚えが同じ重みで思い出され続けると、使うほど答えが悪くなる。
 * それは「使うほど馬鹿になる」。
 *
 * ここで見るのは三つ。
 *   1. 当たった覚えが上がり、外した覚えが下がること
 *   2. 刈るときに、外れから先に落ちること
 *   3. **確かめていない回からは学ばないこと**（思い込みを固めない）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memory, usefulness } from '../src/memory/memory.ts';

describe('役に立ち度', () => {
  test('使っていないうちは、上げも下げもしない', () => {
    assert.equal(usefulness({}), 1);
  });

  test('当たれば上がり、外せば下がる', () => {
    assert.ok(usefulness({ helped: 3, misled: 0 }) > 1);
    assert.ok(usefulness({ helped: 0, misled: 3 }) < 1);
  });

  test('一度の失敗で、良い覚えを捨てない', () => {
    // 5回効いて1回外した覚えは、まだ効く側に居るべき。
    assert.ok(usefulness({ helped: 5, misled: 1 }) > 1);
  });

  test('効きすぎない（幅を決めてある）', () => {
    for (const e of [{ helped: 99, misled: 0 }, { helped: 0, misled: 99 }]) {
      const u = usefulness(e);
      assert.ok(u >= 0.6 && u <= 1.4, `幅を外れた: ${u}`);
    }
  });
});

describe('思い出す順が、使ううちに変わる', () => {
  /** 同じ話題で、当たり外れだけが違う二つ。 */
  function two(): { m: Memory; good: string; bad: string } {
    const m = new Memory();
    const good = m.remember({ kind: 'fact', title: '設定の保存は config.ts', detail: '設定は config.ts に書く' }).entry.id;
    const bad = m.remember({ kind: 'fact', title: '設定の保存は settings.ts', detail: '設定は settings.ts に書く' }).entry.id;
    return { m, good, bad };
  }

  test('はじめは、どちらも出る', () => {
    const { m } = two();
    assert.equal(m.recall('設定の保存').length, 2);
  });

  test('当たった方が上、外した方が下になる', () => {
    const { m, good, bad } = two();
    for (let i = 0; i < 3; i += 1) {
      m.noteRecalled([good, bad]);
      m.noteOutcome([good], true);
      m.noteOutcome([bad], false);
    }
    const order = m.recall('設定の保存').map((e) => e.id);
    assert.equal(order[0], good, `外した覚えが先に出ている: ${order.join(',')}`);
  });

  test('**確かめていない回では、何も動かない**', () => {
    const { m, good, bad } = two();
    const before = m.recall('設定の保存').map((e) => e.id);
    for (let i = 0; i < 5; i += 1) m.noteRecalled([good, bad]);
    const after = m.recall('設定の保存').map((e) => e.id);
    assert.deepEqual(after, before, '確かめていないのに、順が動いた');
  });

  test('添えたことは数えている（結果はまだ付けない）', () => {
    const { m, good } = two();
    m.noteRecalled([good]);
    const got = m.recall('設定の保存').find((e) => e.id === good);
    assert.equal(got?.used, 1, '添えた回数が数えられていない');
    assert.equal(got?.helped, undefined);
  });
});

describe('刈るとき、外れから先に落とす', () => {
  test('新しい外れより、古い当たりを残す', () => {
    const m = new Memory();
    const now = Date.now();
    const old = m.remember({ kind: 'fact', title: '古い当たり', detail: 'よく効いた' }).entry;
    old.at = now - 90 * 86_400_000;
    old.seenAt = old.at;
    for (let i = 0; i < 5; i += 1) { m.noteRecalled([old.id]); m.noteOutcome([old.id], true); }

    const fresh = m.remember({ kind: 'fact', title: '新しい外れ', detail: '毎回はずれた' }).entry;
    for (let i = 0; i < 5; i += 1) { m.noteRecalled([fresh.id]); m.noteOutcome([fresh.id], false); }

    // 埋め草を入れて、上限を超えさせる。
    for (let i = 0; i < 20; i += 1) m.remember({ kind: 'fact', title: `埋め草${i}`, detail: 'どうでもよい' });

    m.compact({ max: 10, now });
    const left = m.all().map((e) => e.title);
    assert.ok(left.includes('古い当たり'), `古い当たりを捨てている: ${left.join(', ')}`);
    assert.ok(!left.includes('新しい外れ'), `新しい外れが残っている: ${left.join(', ')}`);
  });
});
