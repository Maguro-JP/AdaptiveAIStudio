/**
 * 名簿の検証。
 * 役職を消さないこと、変えたら必ず伝わることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
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

  test('formerly で改名したら、前の名前を「名簿から消えた」と言わない（起動のたびにも言わない）', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout', codename: 'SCOUT' })]);
    const roster = [role({ id: 'pathfinder', codename: 'PATHFINDER', formerly: ['scout'] })];
    const renamed = l.sync(roster);
    assert.equal(renamed.some((c) => c.roleId === 'scout'), false, JSON.stringify(renamed));
    assert.equal(renamed.some((c) => c.kind === 'renamed'), true);
    assert.deepEqual(l.sync(roster), [], '同じ名簿で、また何か言っている');
    // 改名した先を本当に消したら、消えたと言うのはその一つだけ（前の名前まで言わない）
    const gone = l.sync([]);
    assert.deepEqual(gone.map((c) => c.roleId), ['pathfinder'], JSON.stringify(gone));
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
    const dir = await tempDir('aas-ledger-');
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

  test('引き継ぎが輪になっていても、立ち上げごと落ちない', () => {
    const base = { name: '旧', responsibility: 'x', disposition: 'y', access: ['read'] as ('read')[], instructions: ['a', 'b', 'c'], retired: true };
    const r = new RoleRegistry([
      { id: 'a', ...base, succeededBy: ['b'] },
      { id: 'b', ...base, succeededBy: ['a'] },
      { id: 'self', ...base, succeededBy: ['self'] },
    ]);
    // 辿り続けて Maximum call stack size exceeded で落ちていた
    assert.ok(r.get('a'), '引けない');
    assert.equal(r.get('self')!.id, 'self');
  });

  test('access を並びで書いていない・知らない語があるときは、権限を足さずに外して言う', () => {
    const said: string[] = [];
    const r = new RoleRegistry([
      // 文字列で書くと includes の部分一致で network が付き、some で投げて立ち上げごと落ちていた
      { id: 'str', name: '文字列', responsibility: 'x', disposition: 'y', access: 'read,write,network' as never, instructions: ['a', 'b', 'c'] },
      { id: 'odd', name: '知らない語', responsibility: 'x', disposition: 'y', access: ['read', 'admin'] as never, instructions: ['a', 'b', 'c'] },
    ], (t) => said.push(t));
    assert.deepEqual(r.get('str')!.access, ['read']);
    assert.deepEqual(r.get('odd')!.access, ['read']);
    assert.ok(said.some((t) => /str: access を並び/.test(t)), said.join('\n'));
    assert.ok(said.some((t) => /odd: 知らない権限 admin/.test(t)), said.join('\n'));
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

describe('記録ファイルが壊れている・読めない', () => {
  const setup = async () => {
    const dir = await tempDir('aas-ledger-f-');
    const path = join(dir, 'roles-ledger.json');
    const first = new RoleLedger(path);
    await first.load();
    first.sync([role({ id: 'scout' }), role({ id: 'smith' }), role({ id: 'retired' })]);
    first.markAnnounced();
    await first.save();
    return { dir, path };
  };

  test('**形の違う一件（null・権限が配列でない）は除き、照合を止めない**', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const { path } = await setup();
    const raw = JSON.parse(await readFile(path, 'utf8')) as { known: Record<string, unknown>[] };
    raw.known.push(null as never, { ...raw.known[0], id: 'odd', access: 'read' });
    await writeFile(path, JSON.stringify(raw));
    const l = new RoleLedger(path);
    await l.load();
    let changes: ReturnType<typeof l.sync> = [];
    assert.doesNotThrow(() => { changes = l.sync([role({ id: 'scout' }), role({ id: 'smith' }), role({ id: 'retired' })]); });
    assert.deepEqual(changes, [], '正しい記録まで捨てて、配属し直しと言った');
  });

  test('**在るのに読めないときは、全員を「配属されました」と言わず、読めるまで書かない**', async () => {
    const { mkdir, rm, readFile, writeFile } = await import('node:fs/promises');
    const { path } = await setup();
    const before = await readFile(path, 'utf8');
    await rm(path);
    await mkdir(path); // 読めない（EISDIR）
    const l = new RoleLedger(path);
    await l.load();
    assert.deepEqual(l.sync([role({ id: 'scout' }), role({ id: 'smith' }), role({ id: 'newbie' })]), [], '前が分からないのに知らせた');
    assert.deepEqual(l.pending(), []);
    await l.save();
    await rm(path, { recursive: true });
    await writeFile(path, before);
    await l.save(); // 読めたので、前の名簿を取り戻して書く
    const saved = JSON.parse(await readFile(path, 'utf8')) as { known: { id: string }[] };
    // 読めなかった間の名簿は覚えない。前の名簿のまま残し、次の起動で照合し直して newbie の配属を知らせる
    assert.deepEqual(saved.known.map((s) => s.id).sort(), ['retired', 'scout', 'smith']);
    const next = new RoleLedger(path);
    await next.load();
    const news = next.sync([role({ id: 'scout', codename: 'RENAMED' }), role({ id: 'smith' }), role({ id: 'newbie' })]);
    assert.deepEqual(news.map((c) => `${c.kind}:${c.roleId}`).sort(), ['joined:newbie', 'renamed:scout', 'succeeded:retired'],
      '読めなかった起動の間の変更を、次の起動で知らせていない');
  });

  test('壊れた JSON は脇へ移し、初めてと同じく配属を知らせる（対）', async () => {
    const { writeFile, readdir } = await import('node:fs/promises');
    const { dir, path } = await setup();
    await writeFile(path, '{"known": [');
    const l = new RoleLedger(path);
    await l.load();
    assert.equal(l.sync([role({ id: 'scout' })]).length, 1);
    assert.ok((await readdir(dir)).some((n) => n.startsWith('roles-ledger.json.broken-')));
  });

  test('**まだ伝えていない変更は、読めなかった起動のあと読めたら取り込んで残す（形の違う一件は除く）**', async () => {
    const { mkdir, rm, readFile, writeFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-ledger-f-');
    const path = join(dir, 'roles-ledger.json');
    const first = new RoleLedger(path);
    await first.load();
    first.sync([role({ id: 'scout' })]); // 知らせる前に落ちた
    await first.save();
    const raw = JSON.parse(await readFile(path, 'utf8')) as { unannounced: unknown[] };
    raw.unannounced.push(null, { at: 'x', kind: 'exploded', roleId: 'a', codename: 'A', detail: 'd' });
    const before = JSON.stringify(raw);
    await rm(path);
    await mkdir(path);
    const l = new RoleLedger(path);
    await l.load();
    l.sync([role({ id: 'scout' })]);
    await rm(path, { recursive: true });
    await writeFile(path, before);
    await l.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { unannounced: { kind: string; roleId: string }[] };
    assert.deepEqual(saved.unannounced.map((c) => `${c.kind}:${c.roleId}`), ['joined:scout'], '未通知の変更を落とした・形の違う一件を残した');
  });

  test('**文字でない呼び名の役職を、起動のたびに「配属されました」と言わない**', async () => {
    const dir = await tempDir('aas-ledger-f-');
    const path = join(dir, 'roles-ledger.json');
    const odd = role({ id: 'odd', codename: 7 as never });
    for (const want of [1, 0, 0]) {
      const l = new RoleLedger(path);
      await l.load();
      assert.equal(l.sync([odd]).length, want);
      l.markAnnounced();
      await l.save();
    }
  });
});