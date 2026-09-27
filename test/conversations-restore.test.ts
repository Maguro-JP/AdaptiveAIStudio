/**
 * 消した会話を戻す。**押し間違えた会話は、ほかに写しが無い。**
 *
 * 画面は「戻せません」と確かめてから消していた。消すと、すぐにファイルを消していた。
 * 今は `trash/` へ移し、立ち上げ直すまでは戻せる。立ち上げたときに本当に消す（消したつもりの会話を長く残さない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Conversations } from '../src/core/conversations.ts';

async function withTalk(): Promise<{ c: Conversations; dir: string; id: string; body: string }> {
  const dir = await tempDir('aas-conv-restore-');
  const c = new Conversations(dir);
  const { id } = await c.create();
  await c.append(id, [{ role: 'user', content: '消したくない話' }, { role: 'assistant', content: 'はい' }]);
  const body = await readFile(join(dir, `${id}.jsonl`), 'utf8');
  return { c, dir, id, body };
}

describe('消した会話を戻す', () => {
  test('**消した会話は一覧から消え、戻すと中身ごと戻る**', async () => {
    const { c, dir, id, body } = await withTalk();
    await c.remove(id);
    assert.deepEqual((await c.list()).map((h) => h.id), []);
    assert.equal(await c.count(), 0, '消した会話を数えている');
    assert.deepEqual(await c.restore(id), { id });
    assert.deepEqual((await c.list()).map((h) => h.id), [id]);
    assert.equal(await readFile(join(dir, `${id}.jsonl`), 'utf8'), body, '中身が変わった');
  });

  test('**立ち上げたときに本当に消す**（消したつもりの会話を、ディスクに長く残さない）', async () => {
    const { c, dir, id } = await withTalk();
    await c.remove(id);
    assert.equal(await c.purgeTrash(), 1);
    assert.equal(await c.restore(id), 'gone');
    const left = await readdir(dir);
    assert.deepEqual(left.filter((n) => n.includes(id)), [], `ファイルが残っている: ${left.join(', ')}`);
    assert.deepEqual(await readdir(join(dir, 'trash')).catch(() => []), [], 'trash の中が残っている');
  });

  test('**同じ名前の会話が在れば上書きせず、別の名前で戻す**（見出しの名前も合わせる）', async () => {
    const { c, dir, id } = await withTalk();
    await c.remove(id);
    await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ t: 'meta', id, title: '後から出来た', createdAt: new Date().toISOString() })}\n`);
    const got = await c.restore(id);
    assert.ok(typeof got === 'object' && got.id !== id, `別の名前で戻していない: ${JSON.stringify(got)}`);
    assert.equal((await c.head(id)).title, '後から出来た', '後から出来た方を上書きした');
    const meta = JSON.parse((await readFile(join(dir, `${got.id}.jsonl`), 'utf8')).split('\n')[0]!) as { id: string };
    assert.equal(meta.id, got.id, '見出しの行の名前が元のまま（ファイルの名前と食い違う）');
    assert.deepEqual((await c.load(got.id)).map((m) => m.content), ['消したくない話', 'はい']);
  });

  test('**消した後に来た書き足しは、消した方へ足す**（切れ端の会話を作らず、戻せばその1ターンも戻る）', async () => {
    const { c, dir, id } = await withTalk();
    await c.remove(id);
    await c.append(id, [{ role: 'assistant', content: '遅れて届いた答え' }]);
    assert.ok(!(await readdir(dir)).includes(`${id}.jsonl`), '切れ端の会話を作った');
    assert.deepEqual((await c.list()).map((h) => h.id), []);
    assert.deepEqual(await c.restore(id), { id });
    assert.deepEqual((await c.load(id)).map((m) => m.content), ['消したくない話', 'はい', '遅れて届いた答え']);
  });

  test('**二度消しても前に消したものを上書きせず、最初に消したものを戻す**', async () => {
    const { c, dir, id } = await withTalk();
    await c.remove(id);
    await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ t: 'meta', id, title: '切れ端', createdAt: new Date().toISOString() })}\n`);
    await c.remove(id);
    assert.equal((await readdir(join(dir, 'trash'))).length, 2, '前に消したものを上書きした');
    assert.deepEqual(await c.restore(id), { id });
    assert.deepEqual((await c.load(id)).map((m) => m.content), ['消したくない話', 'はい'], '最初に消したものを戻していない');
  });

  test('無い会話は戻せないと言い、もう戻っている会話は戻っていると言う。無いものを消しても落ちない', async () => {
    const { c, id } = await withTalk();
    assert.equal(await c.restore(id), 'already');
    await c.remove(id);
    assert.deepEqual(await c.restore(id), { id });
    assert.equal(await c.restore(id), 'already');
    assert.equal(await c.restore('c20260101-000000-0000'), 'gone');
    await c.remove('c20260101-000000-0000');
  });

  test('trash の中のものは、名前が会話の形でも一覧に出さない', async () => {
    const { c, dir } = await withTalk();
    await mkdir(join(dir, 'trash'), { recursive: true });
    await writeFile(join(dir, 'trash', 'c20260101-000000-0001.jsonl'), '');
    assert.equal((await c.list()).length, 1);
  });
});
