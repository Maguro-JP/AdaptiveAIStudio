/**
 * 了解した警告の記憶（`src/core/acks.ts`）。作業場ごとに覚え、取り消せる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tempDir } from './tmp.ts';
import { AckStore, isAckId } from '../src/core/acks.ts';

async function store(): Promise<{ acks: AckStore; file: string }> {
  const dir = await tempDir('aas-acks-');
  const file = join(dir, 'acks.json');
  return { acks: new AckStore(file), file };
}

describe('了解した警告', () => {
  test('了解は作業場ごと。別の作業場では覚えていない', async () => {
    const { acks } = await store();
    assert.equal(await acks.has('outside-uncomparable', '/w/a'), false);
    await acks.add('outside-uncomparable', '/w/a');
    assert.equal(await acks.has('outside-uncomparable', '/w/a'), true);
    assert.equal(await acks.has('outside-uncomparable', '/w/b'), false, '別の作業場まで了解したことにしている');
    // 同じ作業場を別の綴りで訊いても、同じ作業場。
    assert.equal(await acks.has('outside-uncomparable', '/w/a/'), true);
    assert.equal(await acks.has('outside-uncomparable', '/w/x/../a'), true);
  });

  test('取り消せる。閉じたら開けない、を作らない', async () => {
    const { acks } = await store();
    await acks.add('outside-uncomparable', '/w/a');
    await acks.remove('outside-uncomparable', '/w/a');
    assert.equal(await acks.has('outside-uncomparable', '/w/a'), false);
    assert.deepEqual(await acks.list(), []);
  });

  test('二度了解しても一件。時刻は新しい方', async () => {
    const { acks } = await store();
    await acks.add('outside-uncomparable', '/w/a', new Date('2026-09-24T00:00:00Z'));
    await acks.add('outside-uncomparable', '/w/a', new Date('2026-09-25T00:00:00Z'));
    const all = await acks.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.at, '2026-09-25T00:00:00.000Z');
  });

  test('壊れたファイルは「何も了解していない」と読み、次に書けば直る', async () => {
    const { acks, file } = await store();
    await writeFile(file, '{not json');
    assert.deepEqual(await acks.list(), []);
    await acks.add('outside-uncomparable', '/w/a');
    assert.equal(await acks.has('outside-uncomparable', '/w/a'), true);
  });

  test('**読めない記録は空から書き直さず、書き換えなかったと言う**（それまでの了解を消さない）', async () => {
    const { acks: plain, file } = await store();
    await plain.add('outside-uncomparable', '/w/a');
    const before = await readFile(file, 'utf8');
    // 読むたびに EACCES（root で走っても同じ結果になるよう、権限ではなく読む手をモックにする）
    const locked = new AckStore(file, { read: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    assert.deepEqual(await locked.list(), [], '読めないのに了解していると読んだ');
    await assert.rejects(locked.add('outside-uncomparable', '/w/b'), /読めないので、書き換えていません/);
    await assert.rejects(locked.remove('outside-uncomparable', '/w/a'), /読めないので、書き換えていません/);
    assert.equal(await readFile(file, 'utf8'), before, '読めない間に書き換えた');
  });

  test('書けなかったら、書けなかったと言う', async () => {
    const { file } = await store();
    const stuck = new AckStore(file, { write: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
    await assert.rejects(stuck.add('outside-uncomparable', '/w/a'), /書けませんでした/);
  });

  test('**壊れた記録は脇へ移してから書く**（中身の写しが残る）', async () => {
    const { acks, file } = await store();
    await writeFile(file, '{not json');
    await acks.add('outside-uncomparable', '/w/a');
    const aside = (await readdir(dirname(file))).filter((n) => n.startsWith('acks.json.broken-'));
    assert.equal(aside.length, 1, '脇へ移していない');
    assert.equal(await readFile(join(dirname(file), aside[0]!), 'utf8'), '{not json');
  });

  test('**入れ物の形が違う記録は、写しを取ってから書く**（JSON としては読める）', async () => {
    const { acks, file } = await store();
    await writeFile(file, JSON.stringify({ acks: { 'outside-uncomparable': true } }));
    await acks.add('outside-uncomparable', '/w/a');
    const aside = (await readdir(dirname(file))).filter((n) => n.startsWith('acks.json.broken-'));
    assert.equal(aside.length, 1, '写しを取っていない');
    assert.equal(await acks.has('outside-uncomparable', '/w/a'), true);
  });

  test('**知らない形の一件（新しい版が書いた等）は、書き直しても残す**', async () => {
    const { acks, file } = await store();
    const odd = { id: 'future-warning', root: '/w/a', at: '2026-09-28T00:00:00.000Z' };
    await writeFile(file, JSON.stringify({ acks: [odd] }));
    await acks.add('outside-uncomparable', '/w/a');
    await acks.remove('outside-uncomparable', '/w/a');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).acks, [odd]);
  });

  test('知らない名前は了解できる警告ではない', () => {
    assert.equal(isAckId('outside-uncomparable'), true);
    assert.equal(isAckId('something-else'), false);
    assert.equal(isAckId(42), false);
  });
});
