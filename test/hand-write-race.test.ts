/**
 * 画面の手の書き込み（保存・行ごとに戻す・新しいファイル）が、読んでから書くまでの間の書き換えを上書きしない。
 *
 * 呼ぶ側は作業場の錠の手前で前の中身を読む。その間に AI が書くと、AI の書き換えを黙って上書きし、
 * 「戻す」の記録も古い中身になっていた。錠を取った直後に別の所が書き換える形を、`afterHandLock` で作る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-hand-race-state-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const work = join(await tempDir('aas-hand-race-'), 'work');
await mkdir(work, { recursive: true });

/** 錠を取った直後に走らせるもの。試験ごとに入れ替える。 */
let meanwhile: (() => Promise<void>) | undefined;
let base = '';
let server: InstanceType<typeof UiServer>;
before(async () => {
  server = new UiServer({
    config: { ...DEFAULT_CONFIG, agent: { root: work } } as typeof DEFAULT_CONFIG,
    port: 0,
    afterHandLock: async () => { const run = meanwhile; meanwhile = undefined; await run?.(); },
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); });

const send = (method: string, p: string, body: unknown) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('読んでから書くまでの間の書き換えを、手の書き込みが上書きしない', () => {
  test('**保存: 読んだあとで別の所が書き換えたら、書かずに 409 で断り、今の中身を返す**', async () => {
    await writeFile(join(work, 'a.txt'), 'もと\n');
    meanwhile = () => writeFile(join(work, 'a.txt'), 'AI が書いた\n');
    const r = await send('PUT', '/api/file', { path: 'a.txt', content: '人が書いた\n' });
    const j = await r.json() as { error?: string; conflict?: boolean; content?: string };
    assert.equal(r.status, 409, JSON.stringify(j));
    assert.equal(j.conflict, true);
    assert.equal(j.content, 'AI が書いた\n', '今の中身を返していない');
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'AI が書いた\n', 'AI の書き換えを上書きした');
  });

  test('行ごとに戻す: 同じく書かずに断る', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    await writeFile(join(work, 'b.txt'), 'one\nTWO\n');
    const diff = unifiedDiff('b.txt', 'one\ntwo\n', 'one\nTWO\n');
    meanwhile = () => writeFile(join(work, 'b.txt'), 'one\nTWO\nAI\n');
    const r = await send('POST', '/api/revert', { path: 'b.txt', diff, picks: [{ hunk: 0 }] });
    assert.equal(r.status, 409, await r.text());
    assert.equal(await readFile(join(work, 'b.txt'), 'utf8'), 'one\nTWO\nAI\n', 'AI の書き換えを上書きした');
  });

  test('行ごとに戻す口の断りは、差分の開き直しを案内する（選ばせる手が無いので「どちらを残すか」と言わない）', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    await writeFile(join(work, 'b2.txt'), 'one\nTWO\n');
    const diff = unifiedDiff('b2.txt', 'one\ntwo\n', 'one\nTWO\n');
    meanwhile = () => writeFile(join(work, 'b2.txt'), 'one\nTWO\nAI\n');
    const j = await (await send('POST', '/api/revert', { path: 'b2.txt', diff, picks: [{ hunk: 0 }] })).json() as { error: string };
    assert.match(j.error, /差分を開き直して/);
  });

  test('新しいファイル: 作る間に別の所が作ったら、上書きせずに「既にあります」と断る', async () => {
    meanwhile = () => writeFile(join(work, 'n.txt'), 'AI が作った\n');
    const r = await send('POST', '/api/files/new', { path: 'n.txt', kind: 'file' });
    const j = await r.json() as { error: string };
    assert.equal(r.status, 409, JSON.stringify(j));
    assert.match(j.error, /既にあります/);
    assert.equal(await readFile(join(work, 'n.txt'), 'utf8'), 'AI が作った\n', '別の所が作ったものを空で上書きした');
  });

  test('読み直したときに消えていたら、そう返す（画面は「AI の版」を出せない）', async () => {
    const { rm } = await import('node:fs/promises');
    await writeFile(join(work, 'g.txt'), 'もと\n');
    meanwhile = () => rm(join(work, 'g.txt'));
    const r = await send('PUT', '/api/file', { path: 'g.txt', content: '人\n' });
    const j = await r.json() as { gone?: boolean; content?: string };
    assert.equal(r.status, 409);
    assert.equal(j.gone, true, JSON.stringify(j));
    assert.equal(j.content, undefined);
  });

  test('錠が取れなければ、500 ではなく 409 で断り、錠も「戻す」の記録も残さない', async () => {
    await writeFile(join(work, 'l.txt'), 'もと\n');
    const session = await server.session();
    const undoBefore = (await (await fetch(base + '/api/undo')).json() as { list: unknown[] }).list.length;
    // 手前の「作業中か」は通り、錠を取るところだけが負ける形（AI がその間に錠を取った）。
    const real = session.lock.tryAcquire.bind(session.lock);
    session.lock.tryAcquire = () => false;
    try {
      const r = await send('PUT', '/api/file', { path: 'l.txt', content: '人\n' });
      assert.equal(r.status, 409, await r.text());
    } finally {
      session.lock.tryAcquire = real;
    }
    assert.equal(session.lock.held, false, '錠が残った');
    assert.equal(await readFile(join(work, 'l.txt'), 'utf8'), 'もと\n');
    const undoAfter = (await (await fetch(base + '/api/undo')).json() as { list: unknown[] }).list.length;
    assert.equal(undoAfter, undoBefore, '「戻す」の記録が増えた');
  });

  test('割り込みが無ければ、これまでどおり書ける（対）', async () => {
    await writeFile(join(work, 'c.txt'), 'もと\n');
    const r = await send('PUT', '/api/file', { path: 'c.txt', content: '人が書いた\n' });
    assert.equal(r.status, 200, await r.text());
    assert.equal(await readFile(join(work, 'c.txt'), 'utf8'), '人が書いた\n');
  });
});
