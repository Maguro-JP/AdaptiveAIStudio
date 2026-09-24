/**
 * 了解した警告の記憶（`src/core/acks.ts`）。作業場ごとに覚え、取り消せる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  test('知らない名前は了解できる警告ではない', () => {
    assert.equal(isAckId('outside-uncomparable'), true);
    assert.equal(isAckId('something-else'), false);
    assert.equal(isAckId(42), false);
  });
});
