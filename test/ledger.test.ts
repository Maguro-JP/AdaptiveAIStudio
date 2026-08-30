/**
 * 名簿の検証。
 * 役職を消さないこと、変えたら必ず伝わることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleLedger, formatChanges } from '../src/roles/ledger.ts';
import { RoleRegistry } from '../src/roles/registry.ts';
import type { Role } from '../src/roles/role.ts';

const role = (over: Partial<Role> & { id: string }): Role => ({
  codename: over.id.toUpperCase(),
  name: '担当',
  responsibility: '責務',
  disposition: '姿勢',
  access: ['read'],
  instructions: ['a', 'b', 'c'],
  ...over,
});

describe('変更の検出', () => {
  test('新しく配属されたら記録する', () => {
    const l = new RoleLedger();
    const changes = l.sync([role({ id: 'scout' })]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.kind, 'joined');
  });

  test('変わっていなければ何も記録しない', () => {
    const l = new RoleLedger();
    const roles = [role({ id: 'scout' })];
    l.sync(roles);
    assert.deepEqual(l.sync(roles), []);
  });

  test('改名を検出する', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout', codename: 'SCOUT' })]);
    const changes = l.sync([role({ id: 'scout', codename: 'PATHFINDER' })]);
    assert.equal(changes[0]!.kind, 'renamed');
    assert.match(changes[0]!.detail, /SCOUT から PATHFINDER/);
  });

  test('IDごと変えても、旧名を申告していれば改名として扱う', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout', codename: 'SCOUT' })]);
    const changes = l.sync([
      role({ id: 'pathfinder', codename: 'PATHFINDER', formerly: ['scout'] }),
    ]);
    assert.equal(changes.find((c) => c.kind === 'renamed')?.roleId, 'pathfinder');
  });

  test('担当・姿勢・権限の変更をそれぞれ検出する', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'x' })]);
    const changes = l.sync([role({
      id: 'x', responsibility: '別の責務', disposition: '別の姿勢', access: ['read', 'write'],
    })]);
    const kinds = changes.map((c) => c.kind);
    assert.ok(kinds.includes('reassigned'));
    assert.ok(kinds.includes('retuned'));
    assert.ok(kinds.includes('authorized'));
  });

  test('引き継ぎを記録する', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout' }), role({ id: 'envoy' })]);
    const changes = l.sync([
      role({ id: 'scout', succeededBy: ['envoy'], retired: true }),
      role({ id: 'envoy' }),
    ]);
    const succeeded = changes.find((c) => c.kind === 'succeeded');
    assert.ok(succeeded);
    assert.match(succeeded.detail, /ENVOY が引き継ぎました/);
    assert.match(succeeded.detail, /名簿には残ります/);
  });

  test('役職が名簿から消えたら、方針違反として気づける', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout' }), role({ id: 'envoy' })]);
    const changes = l.sync([role({ id: 'envoy' })]);
    const lost = changes.find((c) => c.roleId === 'scout');
    assert.ok(lost, '消えたことに気づいていない');
    assert.match(lost.detail, /消さず/);
  });
});

describe('周知', () => {
  test('伝えるまで残る', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aas-ledger-'));
    const path = join(dir, 'roles.json');

    const first = new RoleLedger(path);
    await first.load();
    first.sync([role({ id: 'scout' })]);
    await first.save();

    // 伝えないまま次回起動
    const second = new RoleLedger(path);
    await second.load();
    assert.equal(second.pending().length, 1, '伝えないうちに消えている');

    second.markAnnounced();
    await second.save();

    const third = new RoleLedger(path);
    await third.load();
    assert.equal(third.pending().length, 0);
  });

  test('文面に何が変わったかが出る', () => {
    const l = new RoleLedger();
    const changes = l.sync([role({ id: 'gremlin', codename: 'GREMLIN', name: '破壊担当' })]);
    const text = formatChanges(changes);
    assert.match(text, /名簿の変更/);
    assert.match(text, /配属/);
    assert.match(text, /GREMLIN/);
  });

  test('変更が無ければ何も言わない', () => {
    assert.equal(formatChanges([]), '');
  });
});

describe('旧名での呼び出し', () => {
  test('改名しても古い名前で引ける', () => {
    const r = new RoleRegistry([
      { id: 'pathfinder', extends: 'scout', codename: 'PATHFINDER', formerly: ['scout'] },
    ]);
    assert.equal(r.get('pathfinder')!.codename, 'PATHFINDER');
    // 組み込みの scout はそのまま残るので、両方引ける
    assert.ok(r.get('scout'));
  });

  test('引き継ぎ済みの役職を呼ぶと、引き継ぎ先に繋がる', () => {
    const r = new RoleRegistry([
      { id: 'old-scout', name: '旧調査', responsibility: 'x', disposition: 'y',
        access: ['read'], instructions: ['a', 'b', 'c'],
        succeededBy: ['envoy'], retired: true },
    ]);
    assert.equal(r.get('old-scout')!.id, 'envoy', '引き継ぎ先に繋がっていない');
  });

  test('引き継ぎ済みでも名簿には残る', () => {
    const r = new RoleRegistry([
      { id: 'old-scout', name: '旧調査', responsibility: 'x', disposition: 'y',
        access: ['read'], instructions: ['a', 'b', 'c'],
        succeededBy: ['envoy'], retired: true },
    ]);
    assert.ok(r.roster().some((x) => x.id === 'old-scout'), '名簿から消えている');
    assert.equal(r.active().some((x) => x.id === 'old-scout'), false,
      '引き継ぎ済みなのに新しい割り当てを受けている');
  });

  test('引き継ぎ先が複数でも、最初に見つかった人に繋がる', () => {
    const r = new RoleRegistry([
      { id: 'split-me', name: '分割元', responsibility: 'x', disposition: 'y',
        access: ['read'], instructions: ['a', 'b', 'c'],
        succeededBy: ['nonexistent', 'envoy'], retired: true },
    ]);
    assert.equal(r.get('split-me')!.id, 'envoy');
  });
});
