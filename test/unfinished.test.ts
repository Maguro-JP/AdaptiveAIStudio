/**
 * やり残しを覚えて、こちらから続ける。
 *
 * ここまで、40往復で切れても、押し戻しても動かなくても、**そこで終わり**
 * だった。次に人が同じことを言い直すまで、誰も続けない。
 * 「自律的に進める」と言いながら、続きは人が覚えている前提だった。
 *
 * 覚えるのはこちらの仕事。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import {
  UnfinishedWork, resumePrompt, whyText, BACKOFF_MS, MAX_ATTEMPTS, MAX_OPEN,
} from '../src/core/unfinished.ts';

async function store(): Promise<{ w: UnfinishedWork; path: string }> {
  const dir = await tempDir('aas-unf-');
  const path = join(dir, 'unfinished.jsonl');
  return { w: new UnfinishedWork(path), path };
}

const item = { request: 'src を直して', why: 'maxTurns' as const, note: '40ターン' };

describe('やり残しを控える', () => {
  test('控えて、読み直せる', async () => {
    const { w } = await store();
    const added = await w.add(item);
    assert.ok(added);
    const list = await w.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.request, 'src を直して');
    assert.equal(list[0]!.attempts, 0);
  });

  test('ファイルに残る。窓を閉じても消えない', async () => {
    // 記憶の中だけだと、いちばん続きが要るとき（長い作業の途中で落ちた）に
    // きれいに消える。
    const { w, path } = await store();
    await w.add(item);
    const again = new UnfinishedWork(path);
    assert.equal((await again.list()).length, 1);
  });

  test('同じ依頼を二重に控えない', async () => {
    const { w } = await store();
    await w.add(item);
    assert.equal(await w.add(item), undefined, '二重に控えている');
    assert.equal((await w.list()).length, 1);
  });

  test('すぐには戻らない', async () => {
    // 落ちた直後にそのまま戻すと、同じところで同じように落ちて、
    // 枠と電気を使うだけになる。
    const now = 1_000_000;
    const { w } = await store();
    await w.add(item, now);
    assert.equal(await w.due(now), undefined, 'すぐ戻している');
    assert.ok(await w.due(now + BACKOFF_MS[0]!), '待っても戻らない');
  });

  test('試すたびに、間隔を延ばす', async () => {
    const now = 1_000_000;
    const { w } = await store();
    const added = (await w.add(item, now))!;
    const r1 = await w.bump(added.id, now);
    assert.equal(r1.gaveUp, false);
    const after = (await w.list())[0]!;
    assert.equal(after.attempts, 1);
    assert.equal(after.nextAt, now + BACKOFF_MS[1]!);
  });

  test('上限まで来たら諦める。諦めたと分かる形で', async () => {
    // 黙って消すと、頼んだことが消えたようにしか見えない。
    const { w } = await store();
    const added = (await w.add(item))!;
    let last = { gaveUp: false, attempts: 0 };
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) last = await w.bump(added.id);
    assert.equal(last.gaveUp, true, '際限なく試している');
    assert.deepEqual(await w.list(), []);
  });

  test('片づいたら外す', async () => {
    const { w } = await store();
    const added = (await w.add(item))!;
    await w.done(added.id);
    assert.deepEqual(await w.list(), []);
  });

  test('利用者がやめられる', async () => {
    const { w } = await store();
    const added = (await w.add(item))!;
    await w.cancel(added.id);
    assert.deepEqual(await w.list(), []);
  });

  test('壊れた行は捨てて、読める分を返す', async () => {
    const { w, path } = await store();
    await w.add(item);
    await writeFile(path, '{"t":"add","item":{"id":"欠け', { flag: 'a' });
    await w.add({ ...item, request: 'ほかのこと' });
    assert.equal((await w.list()).length, 2);
  });

  test('足すだけで書く。丸ごと書き直さない', async () => {
    // 書いている最中に落ちても、そこまでは残る。
    const { w, path } = await store();
    const a = (await w.add(item))!;
    await w.bump(a.id);
    const raw = await readFile(path, 'utf8');
    assert.ok(raw.split('\n').filter((l) => l.trim()).length >= 2, '書き直している');
  });
});

describe('続きの頼み方', () => {
  test('元の依頼を、そのまま渡す', async () => {
    // 要約すると、続きが別の作業になる。
    const { w } = await store();
    const added = (await w.add({ ...item, request: 'src/a.ts の型を直して' }))!;
    const p = resumePrompt(added);
    assert.ok(p.includes('src/a.ts の型を直して'), p);
    // どこまで出来ているかを確かめさせる。やり直させない。
    assert.ok(p.includes('確かめて'), p);
    assert.ok(p.includes('やり直さない'), p);
  });

  test('符丁は、人に見せるときだけ日本語へ引き直す', () => {
    // 基幹に日本語を置かない。持つのは符丁。
    for (const why of ['maxTurns', 'noProgress', 'unverified', 'failed'] as const) {
      assert.ok(whyText(why).length > 0, why);
    }
  });
});

/**
 * 溜めすぎない。
 *
 * やり残しは落ちるたびに増える。**上限が無かったので、放っておくと
 * 際限なく溜まる**（500 件で 521KB。画面にも全部並ぶ）。
 * 追記式なので、閉じたものの行も残り続け、読むたびに全部を解くことになる。
 */
describe('溜めすぎない', () => {
  test('抱える数に上限がある', async () => {
    const dir = await tempDir('aas-unf-cap-');
    const u = new UnfinishedWork(join(dir, 'u.jsonl'));
    for (let i = 0; i < MAX_OPEN + 20; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'failed', note: 'x' });
    }
    const left = await u.list();
    assert.equal(left.length, MAX_OPEN, `上限が効いていない: ${left.length}`);
  });

  test('落とすのは古い方から（新しい方が、いまの状況に近い）', async () => {
    const dir = await tempDir('aas-unf-old-');
    const u = new UnfinishedWork(join(dir, 'u.jsonl'));
    for (let i = 0; i < MAX_OPEN + 5; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'failed', note: 'x' });
    }
    const left = await u.list();
    assert.ok(!left.some((x) => x.request === 'やり残し0'), '古いものが残っている');
    assert.ok(left.some((x) => x.request === `やり残し${MAX_OPEN + 4}`), '新しいものが落ちている');
  });

  test('**記録そのものも畳む**（閉じた行が残り続けない）', async () => {
    const { stat } = await import('node:fs/promises');
    const dir = await tempDir('aas-unf-small-');
    const at = join(dir, 'u.jsonl');
    const u = new UnfinishedWork(at);
    for (let i = 0; i < 400; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'failed', note: 'う'.repeat(200) });
    }
    const size = (await stat(at)).size;
    const live = (await u.list()).length;
    // 生きている分に見合う大きさに収まっていること。
    // 日本語は1文字3バイトなので、200字なら 600 バイト + 包みの分。
    // 畳まないと 400 件ぶん（10,000 バイト/件）残る。
    assert.ok(size < live * 2000, `畳んでいない: ${size} バイト / 生きている ${live} 件`);
  });
});

describe('やり残しの記録を読めないとき', () => {
  const denied = () => Promise.reject(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }));

  test('回数を進めずに投げる（0 回で「諦めた」と言わない）', async () => {
    const path = join(await tempDir('aas-unfinished-unreadable-'), 'unfinished.jsonl');
    const w = new UnfinishedWork(path);
    const item = (await w.add({ request: '依頼', why: 'noProgress', note: 'x' }))!;
    const r = new UnfinishedWork(path, { read: denied });
    await assert.rejects(r.bump(item.id), /EACCES/);
    assert.equal((await w.list())[0]?.attempts, 0, '回数を進めた');
  });

  test('重なりを確かめられないまま、同じ依頼を二重に足さない', async () => {
    const path = join(await tempDir('aas-unfinished-unreadable-'), 'unfinished.jsonl');
    const w = new UnfinishedWork(path);
    await w.add({ request: '依頼', why: 'noProgress', note: 'x' });
    const r = new UnfinishedWork(path, { read: denied });
    await assert.rejects(r.add({ request: '依頼', why: 'noProgress', note: 'x' }), /EACCES/);
    assert.equal((await w.list()).length, 1, '同じ依頼を二重に記録した');
  });

  test('読めないときは区切りを入れて書き足す（半端な最終行と繋げない）', async () => {
    const path = join(await tempDir('aas-unfinished-unreadable-'), 'unfinished.jsonl');
    const w = new UnfinishedWork(path);
    const item = (await w.add({ request: '依頼', why: 'noProgress', note: 'x' }))!;
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"t":"bump","id":"half');
    const r = new UnfinishedWork(path, { read: denied });
    await r.done(item.id);
    assert.deepEqual(await w.list(), [], '書き足した行が半端な行と繋がって読めない');
  });
});
