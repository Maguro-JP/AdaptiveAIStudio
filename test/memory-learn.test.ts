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

/**
 * 成功と失敗を、同じ引き方にしない。
 *
 * 利用者の言葉をそのまま置く。
 *
 * > 成功は他では使えないことが殆どだけど、失敗は他でも効く
 *
 * うまくいった手は、その場の事情込みで成り立っている。持ち出すと外れるうえに
 * 「その手しか取らない」を作る。やってはいけない形は、場所に依らない。
 */
describe('失敗は遠くまで、成功は近くだけ', () => {
  /** 同じ一語だけが掠る、成功と失敗。 */
  function pair(): { m: Memory; win: string; lose: string } {
    const m = new Memory();
    const win = m.remember({
      kind: 'attempt', title: '認証の実装', detail: 'セッションを cookie に載せた',
      outcome: 'worked', tags: ['src/auth.ts'],
    }).entry.id;
    const lose = m.remember({
      kind: 'attempt', title: '認証の実装', detail: '同期で書いたら固まった',
      outcome: 'failed', tags: ['src/auth.ts'],
    }).entry.id;
    return { m, win, lose };
  }

  test('掠っただけの話題には、失敗だけが出る', () => {
    const { m, lose } = pair();
    // 「認証」だけが重なる、別の場所の作業。
    const got = m.recall('認証').map((e) => e.id);
    assert.deepEqual(got, [lose], `成功が別の場所へ流れ出ている: ${got.join(',')}`);
  });

  test('同じ場所なら、成功も出る（触ったものが一致する）', () => {
    const { m, win, lose } = pair();
    const got = m.recall('src/auth.ts を直す').map((e) => e.id);
    assert.ok(got.includes(win), `同じ場所なのに成功が出ない: ${got.join(',')}`);
    assert.ok(got.includes(lose));
  });

  test('近いことの証拠が二つあれば、成功も出る', () => {
    const { m, win } = pair();
    assert.ok(m.recall('認証の実装').map((e) => e.id).includes(win));
  });

  test('同じ重なりなら、失敗が先に出る', () => {
    const { m, lose } = pair();
    assert.equal(m.recall('認証の実装')[0]?.id, lose);
  });

  test('刈るときも、失敗を長く持つ', () => {
    const m = new Memory();
    const now = Date.now();
    for (const [title, outcome] of [['古い成功', 'worked'], ['古い失敗', 'failed']] as const) {
      const e = m.remember({ kind: 'attempt', title, detail: title, outcome }).entry;
      e.at = now - 60 * 86_400_000;
      e.seenAt = e.at;
    }
    for (let i = 0; i < 20; i += 1) m.remember({ kind: 'fact', title: `埋め草${i}`, detail: 'x' });
    m.compact({ max: 12, now });
    const left = m.all().map((e) => e.title);
    assert.ok(left.includes('古い失敗'), `失敗を先に捨てている: ${left.join(', ')}`);
    assert.ok(!left.includes('古い成功'), `成功が失敗より残っている: ${left.join(', ')}`);
  });
});

/**
 * 同じ学びを、一往復に二度入れない。
 *
 * 決まり（system）と思い出しの両方に載せていたので、八件ずつ二重に入っていた。
 * 狭い窓のモデルほど効く（そのぶん、肝心の依頼が押し出される）。
 */
describe('二度載せない', () => {
  test('決まりの側で載せるときは、思い出しから外す', () => {
    const m = new Memory();
    m.seedLessons();
    m.remember({ kind: 'fact', title: '設定は config.ts', detail: 'config.ts に書く' });

    const withLessons = m.recall('設定');
    const without = m.recall('設定', { lessons: false });
    assert.ok(withLessons.some((e) => e.kind === 'displeasure'), '既定では載る');
    assert.equal(without.some((e) => e.kind === 'displeasure'), false, '外したのに載っている');
    // 他のものは、外しても残る。
    assert.ok(without.some((e) => e.kind === 'fact'));
  });
});
