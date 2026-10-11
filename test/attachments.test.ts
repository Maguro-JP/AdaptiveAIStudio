/**
 * 渡されたファイルの預かり。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { Attachments, detectKind, safeName, MAX_BYTES, MAX_INLINE_CHARS } from '../src/ui/attachments.ts';
import { mentionBudget } from '../src/agent/mention.ts';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('種類の見分け', () => {
  test('拡張子で分かるものは、それで分ける', () => {
    assert.equal(detectKind('a.ts', Buffer.from('const x = 1')), 'text');
    assert.equal(detectKind('a.png', Buffer.from('なんでも')), 'image');
  });

  test('拡張子が無くても、中身で分かる', () => {
    // 拡張子の無いファイルは多い。名前だけに頼らない。
    assert.equal(detectKind('Makefile', Buffer.from('all:\n\techo hi')), 'text');
    assert.equal(detectKind('noname', png), 'image');
  });

  test('0 バイトが混ざっていれば、文字ものではない', () => {
    assert.equal(detectKind('x', Buffer.from([0x41, 0x00, 0x42])), 'binary');
  });
});

describe('名前の始末', () => {
  test('渡された名前を、そのまま置き場所に使わない', () => {
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('C:\\Windows\\evil.txt'), 'evil.txt');
    assert.equal(safeName('a<b>c:d'), 'a_b_c_d');
    assert.equal(safeName(''), 'file');
    assert.equal(safeName('...'), 'file');
  });

  test('長すぎる名前は切る', () => {
    assert.ok(safeName('あ'.repeat(500)).length <= 120);
  });
});

describe('預かる', () => {
  const store = async () => new Attachments(join(await tempDir('aas-attach-'), 'files'));

  test('置いて、引ける', async () => {
    const s = await store();
    const item = await s.add('note.md', Buffer.from('# みだし'));
    assert.equal(item.kind, 'text');
    assert.equal(s.get(item.id)?.name, 'note.md');
    assert.equal(s.list().length, 1);
  });

  test('空のものは受け取らない', async () => {
    const s = await store();
    await assert.rejects(s.add('x.txt', Buffer.alloc(0)), /空/);
  });

  test('大きすぎるものは受け取らない', async () => {
    const s = await store();
    // 実体は作らない（試験で数十MBを書くと、それだけで遅くなる）
    const big = Buffer.alloc(0);
    Object.defineProperty(big, 'length', { value: MAX_BYTES + 1 });
    await assert.rejects(s.add('big.bin', big), /大きすぎ/);
  });

  test('外せる', async () => {
    const s = await store();
    const item = await s.add('a.txt', Buffer.from('x'));
    assert.deepEqual(await s.drop(item.id), { dropped: true });
    assert.equal(s.get(item.id), undefined);
    assert.deepEqual(await s.drop(item.id), { dropped: false });
  });

  test('写しを消せなかったときは、外したうえで消せなかったと返す（消したつもりで残さない）', async () => {
    const s = await store();
    const item = await s.add('a.txt', Buffer.from('x'));
    const real = fsp.rm;
    (fsp as { rm: unknown }).rm = ((p: unknown, ...rest: unknown[]) => p === item.path
      ? Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))
      : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as never;
    syncBuiltinESMExports();
    try {
      const r = await s.drop(item.id);
      assert.equal(r.dropped, true);
      assert.match(r.kept ?? '', /EBUSY/);
      assert.equal(s.get(item.id), undefined, '預かりから外していない');
    } finally {
      (fsp as { rm: unknown }).rm = real;
      syncBuiltinESMExports();
    }
  });
});

describe('依頼に添える形', () => {
  const store = async () => new Attachments(join(await tempDir('aas-attach-'), 'files'));

  test('文字ものは中身をそのまま入れる', async () => {
    const s = await store();
    const item = await s.add('main.ts', Buffer.from('const answer = 42;'));
    const text = await s.describe([item.id]);
    assert.match(text, /main\.ts/);
    assert.match(text, /const answer = 42;/);
  });

  test('長すぎる中身は切る。切ったことを言う', async () => {
    const s = await store();
    const item = await s.add('big.log', Buffer.from('あ'.repeat(50_000)));
    const text = await s.describe([item.id]);
    assert.match(text, /省略/);
  });

  test('画像は、読めないなら読めないと言う', async () => {
    const s = await store();
    const item = await s.add('shot.png', png);
    const text = await s.describe([item.id]);
    assert.match(text, /画像の中身はモデルに渡していません/);
    assert.match(text, /置き場所/);
    // 画像を渡す道はまだ無いので、切り替えれば読めるとは案内しない（DECISIONS 10-11、112 回目）
    assert.doesNotMatch(text, /切り替え/);
  });

  test('画像を読めるモデルなら、場所だけ渡す', async () => {
    const s = await store();
    const item = await s.add('shot.png', png);
    const text = await s.describe([item.id], { canSeeImages: true });
    assert.equal(/読めません/.test(text), false);
  });

  test('読めない形式の中身は渡さない。場所を食うだけなので', async () => {
    const s = await store();
    const item = await s.add('a.bin', Buffer.from([0x41, 0x00, 0x42, 0x00]));
    const text = await s.describe([item.id]);
    assert.match(text, /中身を読めない形式/);
    assert.equal(text.includes('AB'), false);
  });

  test('知らない id は黙って飛ばす', async () => {
    const s = await store();
    assert.equal(await s.describe(['そんなものはない']), '');
  });
});

describe('溜めない', () => {
  test('古いものは片づける。渡したものは、その依頼が終われば要らない', async () => {
    const s = new Attachments(join(await tempDir('aas-attach-'), 'files'));
    const item = await s.add('a.txt', Buffer.from('xxxx'));
    // 依頼に添えたもの（まだ添えていないものは画面の受け皿に載っているので片づけない。`test/hand-write-gaps.test.ts`）
    await s.describe([item.id]);
    /*
     * **時計に頼らない。**ここは「2ms 先の時計で見る」で古さを作っていた。
     * Windows の CI で落ちた（書いた時刻が 2ms 以内に収まらない、あるいは
     * 丸められる）。走らせる機械で結果が変わる試験なので、時計を動かす代わりに
     * **ファイルの時刻を過去へ動かす。**どの機械でも同じ答えになる。
     */
    const { utimes } = await import('node:fs/promises');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(item.path, twoDaysAgo, twoDaysAgo);
    const freed = await s.sweep(24 * 60 * 60 * 1000);
    assert.ok(freed > 0, '片づいていない');
    assert.equal(s.get(item.id), undefined);
  });

  test('新しいものは残す', async () => {
    const s = new Attachments(join(await tempDir('aas-attach-'), 'files'));
    const item = await s.add('a.txt', Buffer.from('xxxx'));
    assert.equal(await s.sweep(60_000), 0);
    assert.ok(s.get(item.id));
  });
});

describe('CP932 のファイルを、読めないと言わない', () => {
  // Excel が書いた CSV の形。見出しと一行、CP932。
  const csv = Buffer.from([
    0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c, 0x0d, 0x0a, // 名前,値\r\n
    0x82, 0xa0, 0x2c, 0x31, 0x0d, 0x0a,                    // あ,1\r\n
  ]);

  test('拡張子が無くても、文字ものと見る', () => {
    assert.equal(detectKind('メモ', csv), 'text');
  });

  test('依頼に差し込むとき、化けずに入り、CP932 だったと分かる', async () => {
    const box = new Attachments(await tempDir('aas-att-'));
    const item = await box.add('list.csv', csv);
    assert.equal(item.encoding, 'shift_jis');
    const text = await box.describe([item.id]);
    assert.match(text, /名前,値/);
    assert.match(text, /あ,1/);
    assert.match(text, /CP932 として読みました/);
    assert.doesNotMatch(text, /�/);
  });

  test('UTF-8 のときは、余計な但し書きを付けない（対）', async () => {
    const box = new Attachments(await tempDir('aas-att-'));
    const item = await box.add('list.csv', Buffer.from('名前,値\nあ,1\n', 'utf8'));
    assert.equal(item.encoding, 'utf-8');
    assert.doesNotMatch(await box.describe([item.id]), /CP932/);
  });
});

describe('添付の名前', () => {
  /**
   * 名前は UUID を8桁に切って作っている。切っている以上ぶつかりうる。
   * ぶつかったまま入れると、**先にあった添付が地図から消え、
   * ファイルだけが置き場所に残る**。乱数まかせでは検査にならないので、
   * 名前の作り手を差し替えて、必ずぶつかる形で見る。
   */
  test('**名前がぶつかっても、先にあった添付を消さない**', async () => {
    const ids = ['aaaaaaaa', 'aaaaaaaa', 'bbbbbbbb'];
    let i = 0;
    const box = new Attachments(await tempDir('aas-att-'), { id: () => ids[i++] ?? 'zzzzzzzz' });

    const first = await box.add('one.txt', Buffer.from('ひとつ目', 'utf8'));
    const second = await box.add('two.txt', Buffer.from('ふたつ目', 'utf8'));

    assert.notEqual(first.id, second.id);
    assert.equal(box.list().length, 2);
    assert.equal(box.get(first.id)?.name, 'one.txt');
    assert.equal(box.get(second.id)?.name, 'two.txt');
  });
});

describe('窓に合わせて切る', () => {
  const big = 'あ'.repeat(60_000);
  /** 窓 4096（手元で動く小さいモデルの並び）での取り分。 */
  const narrow = mentionBudget(4096);
  const wide = mentionBudget(16852);

  /**
   * 差し込む中身は固定の 40,000 文字までで、**窓を見ていなかった**。
   * 窓 4096 の相手に 40,052 文字を渡していた（実測。日本語は概ね
   * 1文字1トークンなので、窓のおよそ 10 倍）。5 件なら 200,268 文字で 49 倍。
   * 添付は依頼の一部なので、**刈る側は落とせない**。
   */
  test('**窓が狭ければ、添付も短くなる**', async () => {
    const box = new Attachments(await tempDir('aas-att-win-'));
    const item = await box.add('log.txt', Buffer.from(big, 'utf8'));

    const small = await box.describe([item.id], { chars: narrow });
    const large = await box.describe([item.id], { chars: wide });

    assert.ok(small.length < narrow.total * 1.2,
      `窓 4096 に収まっていない: ${small.length} 文字（取り分 ${narrow.total}）`);
    assert.ok(large.length > small.length * 2,
      `窓が広いのに増えていない: ${small.length} → ${large.length}`);
    assert.ok(large.length < wide.total * 1.2,
      `窓 16852 に収まっていない: ${large.length} 文字（取り分 ${wide.total}）`);
  });

  test('**何件付けても、合計が取り分を大きく超えない**', async () => {
    const box = new Attachments(await tempDir('aas-att-many-'));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await box.add(`log${i}.txt`, Buffer.from(big, 'utf8'))).id);
    }
    const text = await box.describe(ids, { chars: narrow });
    assert.ok(text.length < narrow.total * 1.2,
      `件数ぶん膨らんでいる: ${text.length} 文字（取り分 ${narrow.total}）`);
  });

  test('入らなかった添付を、黙って落とさない', async () => {
    const box = new Attachments(await tempDir('aas-att-left-'));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await box.add(`log${i}.txt`, Buffer.from(big, 'utf8'))).id);
    }
    const text = await box.describe(ids, { chars: narrow });
    assert.match(text, /件は、窓に収まらないので入れていません/);
  });

  test('窓を渡さなければ、これまでどおり（受け皿）', async () => {
    const box = new Attachments(await tempDir('aas-att-old-'));
    const item = await box.add('log.txt', Buffer.from(big, 'utf8'));
    const text = await box.describe([item.id]);
    assert.ok(text.length > MAX_INLINE_CHARS, `受け皿まで縮んでいる: ${text.length}`);
  });
});
