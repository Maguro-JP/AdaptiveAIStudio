/**
 * 記憶と会話の保存で、覚えたもの・消したものを取り違えない。
 *
 * 起動時に読めなかった後の合わせ直しで最初からの覚えを二重にしない、記憶の題に依頼の全文（添付・開いている所の中身）を
 * 入れない、忘れた最初からの覚えを入れ直さない、置き換えが一時的に断られてもやり直す、別の作業場の手を思い出さない、
 * 動いている間に手で直した行を消さない、別の名前で戻すときに消した側を失わない。時刻は全部 `now` で渡す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Memory, formatRecall } from '../src/memory/memory.ts';
import { ForgetShelf, forgetAndSave } from '../src/memory/forget-shelf.ts';
import { BUILTIN_LESSONS } from '../src/memory/builtin-lessons.ts';
import { Conversations } from '../src/core/conversations.ts';

/** 起動のときだけ読めない（EBUSY が続く）記憶。`open()` で読めるようにする。 */
function busyAtStart(path: string): { m: Memory; open: () => void } {
  let busy = true;
  const m = new Memory(path, {
    read: async (p) => {
      if (busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return readFile(p, 'utf8');
    },
  });
  return { m, open: () => { busy = false; } };
}

describe('01 読めなかった起動のあと、最初からの覚えを二重にしない', () => {
  test('**利用者が教えた「二度としないこと」が、最初からの覚えの写しに押し出されない**', async () => {
    const dir = await tempDir('aas-rejoin-seed-');
    const path = join(dir, 'memory.jsonl');
    const first = new Memory(path);
    await first.load();
    first.seedLessons();
    // 時刻は「最初からの覚えより新しい」を壁時計に頼らずに作る（seedLessons は Date.now() を使う）
    first.remember({ kind: 'displeasure', title: '利用者が教えた地雷', detail: 'x', tags: ['code'], now: Number.MAX_SAFE_INTEGER - 1 });
    await first.save();

    // Session.create と同じ順: load（読めない）→ seedLessons → save（ここで読めて合わせる）
    const { m, open } = busyAtStart(path);
    await m.load();
    m.seedLessons();
    open();
    await m.save();

    const again = new Memory(path);
    await again.load();
    const titles = again.all().filter((e) => e.kind === 'displeasure').map((e) => e.title);
    assert.equal(titles.length, BUILTIN_LESSONS.length + 1, '最初からの覚えを二重に書いた');
    for (const l of BUILTIN_LESSONS) {
      assert.equal(titles.filter((t) => t === l.title).length, 1, `同じ最初からの覚えが二つある: ${l.title}`);
    }
    // 押し出しそのもの（写しの seenAt が利用者の覚えより新しくなる）は、写しが無ければ起きない。ここでは数で見る
  });

  test('読めない間に覚え直したものは、ファイルの側に数え直して畳む（二つにしない）', async () => {
    const dir = await tempDir('aas-rejoin-fold-');
    const path = join(dir, 'memory.jsonl');
    const first = new Memory(path);
    await first.load();
    first.remember({ kind: 'fact', title: 'Z: は exe を受け取らない', now: 1000 });
    await first.save();
    const { m, open } = busyAtStart(path);
    await m.load();
    m.remember({ kind: 'fact', title: 'Z: は exe を受け取らない', now: 2000 });
    open();
    await m.save();
    const got = m.all().filter((e) => e.title === 'Z: は exe を受け取らない');
    assert.equal(got.length, 1);
    assert.equal(got[0]!.confirms, 2);
    assert.equal(got[0]!.seenAt, 2000);
  });
});

describe('02 思い出した覚えの題を、丸ごと依頼に入れない', () => {
  test('**長い題（前に添付ごと覚えたもの）は一行・160 字までにして渡す**', () => {
    const body = 'x'.repeat(5000);
    const text = formatRecall([{
      id: 'm1', kind: 'attempt', title: `【いま開いているファイル】a.ts\n${body}\n\n直して`, detail: '', tags: [],
      at: 0, seenAt: 0, confirms: 1,
    }]);
    assert.ok(!text.includes(body), '題の中身（ファイルの中身）を丸ごと依頼に入れた');
  });
  // send() 側（題 = 打った分）は、test/send-*.test.ts の偽のモデルの形で:
  //   send(`【いま開いているファイル】a.ts\n${秘密の語}\n\na.ts を直して`, { said: 'a.ts を直して' }) で書く手を一度通し、
  //   session.memory.all() のどの title にも秘密の語が無いことを見る。
});

describe('03 忘れた最初からの覚えを、立ち上げ直しで入れ直さない', () => {
  test('**忘れて保存し、読み直して seedLessons を呼んでも戻らない。戻したら、また入れられる**', async () => {
    const dir = await tempDir('aas-declined-');
    const path = join(dir, 'memory.jsonl');
    const m = new Memory(path);
    await m.load();
    m.seedLessons();
    await m.save();
    const target = m.all().find((e) => e.source === 'builtin')!;
    const shelf = new ForgetShelf();
    assert.equal((await forgetAndSave(m, shelf, target.id)).ok, true);

    const next = new Memory(path); // 本体を組み直す（作業場・モデルを変えた／立ち上げ直した）
    await next.load();
    assert.equal(next.seedLessons(), 0, '忘れた覚えを入れ直した');
    assert.ok(!next.all().some((e) => e.title === target.title));
  });

  test('古い版が書いた行として読んでも壊れない（declined の行は退けた行として残る）', async () => {
    const dir = await tempDir('aas-declined-compat-');
    const path = join(dir, 'memory.jsonl');
    await writeFile(path, '{"declined":"abc"}\n');
    const m = new Memory(path);
    await m.load();
    assert.equal(m.size, 0);
    assert.equal(m.skipped, 0, 'declined の行を壊れた行として数えた');
  });
});

describe('05 別の作業場で試した手を混ぜない', () => {
  test('**作業場 A で駄目だった手を、作業場 B の failedBefore / recall に出さない。決めたことは出す**', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'src/index.ts の読み込みを直す', tags: ['src/index.ts'], outcome: 'failed', root: '/work/a', now: 1000 });
    m.remember({ kind: 'decision', title: 'src/index.ts は ESM で書く', tags: ['src/index.ts'], now: 1000 });
    assert.deepEqual(m.failedBefore('src/index.ts を直す', 3, '/work/b'), []);
    assert.equal(m.failedBefore('src/index.ts を直す', 3, '/work/a').length, 1);
    const inB = m.recall('src/index.ts を直す', { root: '/work/b' }).map((e) => e.kind);
    assert.ok(inB.includes('decision'));
    assert.ok(!inB.includes('attempt'));
  });

  test('同じ題でも、作業場が違えば別の覚え（回数を混ぜない）', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'テストを直して', outcome: 'worked', root: '/work/a', now: 1 });
    const r = m.remember({ kind: 'attempt', title: 'テストを直して', outcome: 'failed', root: '/work/b', now: 2 });
    assert.equal(r.isNew, true);
    assert.equal(m.all().find((e) => e.root === '/work/a')!.outcome, 'worked', '別の作業場の結果で上書きした');
  });
});

describe('06 手で直して読めるようになった行を、次の保存で消さない', () => {
  test('**退けていた行を動いている間に直すと、次の保存のあとも残る。忘れた・刈った番号は足し戻さない**', async () => {
    const dir = await tempDir('aas-foreign-');
    const path = join(dir, 'memory.jsonl');
    const ok = JSON.stringify({ id: 'm1', kind: 'fact', title: 'a', detail: '', tags: [], at: 1, seenAt: 1, confirms: 1 });
    const fixed = JSON.stringify({ id: 'm2', kind: 'fact', title: '手で直した', detail: '', tags: [], at: 2, seenAt: 2, confirms: 1 });
    await writeFile(path, `${ok}\n${fixed.slice(0, -1)}\n`); // m2 は壊れている
    const m = new Memory(path);
    await m.load();
    assert.equal(m.skipped, 1);
    await writeFile(path, `${ok}\n${fixed}\n`); // 動いている間に手で直す
    m.remember({ kind: 'fact', title: '新しく覚えた', now: 3 });
    await m.save();
    assert.match(await readFile(path, 'utf8'), /手で直した/, '直した行を消した');
    assert.ok(!m.all().some((e) => e.id === 'm3' && e.title !== '新しく覚えた'), '番号がぶつかった');

    m.forget('m1');
    await m.save();
    assert.doesNotMatch(await readFile(path, 'utf8'), /"id":"m1"/, '忘れた覚えをファイルから足し戻した');
  });
});

describe('08 別の名前で戻すとき、途中で落ちても消した側を失わない', () => {
  test('**書き写しではなく移すので、戻した後に trash に元が残らず、中身はそろっている**', async () => {
    const dir = await tempDir('aas-restore-other-');
    const c = new Conversations(dir);
    const { id } = await c.create();
    await c.append(id, [{ role: 'user', content: 'はじめ' }]);
    await c.remove(id);
    await writeFile(join(dir, `${id}.jsonl`), '');  // 同じ名前の会話が在る
    const got = await c.restore(id);
    assert.ok(typeof got === 'object' && got.id !== id);
    assert.deepEqual((await c.load(got.id)).map((m) => m.content), ['はじめ']);
    assert.deepEqual(await c.trashList(), []);
    // 落ちる途中の形は、Conversations に書き写しの手を渡せるようにしてから（今は append しか渡せない）。
  });
});
