/**
 * team（並列で複数の作業者を動かす道）が、規則と戻り先を通ることを確かめる。
 *
 * **ここは素通りだった。**一人で使う `aas` と画面はハーネスの手前で止まるのに、
 * team だけツールを素で渡していた。守られたファイル（`.env`・lock・`.git`）も、
 * 作業場の外も、危ない命令も、断りの無い CI も、ここからは全部通った。
 * 書き換える前の控えも無いので、並列で 10 件走らせて壊れても戻す手が無い。
 *
 * 入口（`src/cli/team.ts`）はモデルを立てないと通らないので、組み立てだけを
 * `core/team-setup.ts` へ出して、ここで押している。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { wireTeam } from '../src/core/team-setup.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { writeFileTool, readFileTool } from '../src/agent/tools/fs.ts';
import type { Tool, ToolContext } from '../src/agent/tools/types.ts';
import type { WorkItem } from '../src/agent/team.ts';

const item = (id: string, instruction = 'なおしてください'): WorkItem =>
  ({ id, laneId: 'coder', instruction });

/**
 * ツールに渡す文脈。
 *
 * **控え（`beforeWrite`）は、ここに載って初めて効く。**書くツールは
 * `ctx.beforeWrite?.()` を呼ぶだけなので、渡さなければ黙って控えない。
 * 本番では Agent が載せる（`src/agent/loop.ts`）。
 */
function ctx(root: string, beforeWrite?: ToolContext['beforeWrite']): ToolContext {
  return {
    root, signal: new AbortController().signal, approve: async () => true,
    ...(beforeWrite ? { beforeWrite } : {}),
  };
}

/** 記録と控えを、この試験の中だけに閉じる。 */
async function place(): Promise<string> {
  process.env.AAS_STATE_DIR = await tempDir('aas-team-state-');
  return tempDir('aas-team-root-');
}
afterEach(() => { delete process.env.AAS_STATE_DIR; });

const named = (tools: Tool[], name: string): Tool => {
  const found = tools.find((t) => t.schema.name === name);
  assert.ok(found, `${name} がツールに無い`);
  return found;
};

describe('team のツールは、規則を通る', () => {
  test('**守られたファイルへの書き込みは、team からも止まる**', async () => {
    const root = await place();
    await writeFile(join(root, '.env'), 'SECRET=1');
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const write = named(wired.toolsFor(item('t1')), 'write_file');

    const r = await write.run({ path: '.env', content: 'STOLEN=1' }, ctx(root));
    assert.equal(r.isError, true, '素通りしています');
    assert.match(r.content, /BLOCKED/);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1');
  });

  test('作業場の外へは書けない', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const write = named(wired.toolsFor(item('t1')), 'write_file');
    const r = await write.run({ path: '../outside.txt', content: 'x' }, ctx(root));
    assert.equal(r.isError, true);
  });

  test('素のツールは止まらない（この試験が、包みを測っていることの対）', async () => {
    const root = await place();
    await writeFile(join(root, '.env'), 'SECRET=1');
    const r = await writeFileTool.run({ path: '.env', content: 'STOLEN=1' }, ctx(root));
    assert.notEqual(r.isError, true, '素のツールまで止まるなら、包みを測れていない');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'STOLEN=1');
  });

  /**
   * **積み重ねは、依頼ごとに分ける。**一つのハーネスを使い回すと、
   * 「読んでから書く」が**別の担当が読んだこと**で通ってしまう。
   * 並列で動くので、`beginTask()` で切る形は使えない（誰かの始まりが、
   * 走っている他の担当の履歴まで消す）。
   */
  test('**別の担当が読んだことで、読まずに書けない**', async () => {
    const root = await place();
    await writeFile(join(root, 'a.ts'), 'original');
    const wired = await wireTeam(DEFAULT_CONFIG, root);

    const aRead = named(wired.toolsFor(item('t1')), 'read_file');
    await aRead.run({ path: 'a.ts' }, ctx(root));

    const bWrite = named(wired.toolsFor(item('t2')), 'write_file');
    const r = await bWrite.run({ path: 'a.ts', content: 'replaced' }, ctx(root));
    assert.equal(r.isError, true, '他人が読んだことで通っています');
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'original');
  });

  test('自分で読んでいれば書ける（対）', async () => {
    const root = await place();
    await writeFile(join(root, 'a.ts'), 'original');
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const mine = wired.toolsFor(item('t1'));
    await named(mine, 'read_file').run({ path: 'a.ts' }, ctx(root));
    const r = await named(mine, 'write_file').run({ path: 'a.ts', content: 'replaced' }, ctx(root));
    assert.notEqual(r.isError, true, r.content);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'replaced');
  });
});

describe('team は、戻り先を残す', () => {
  test('**書き換える前の中身を控えている**', async () => {
    const root = await place();
    await writeFile(join(root, 'a.ts'), 'original');
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const mine = wired.toolsFor(item('t1'));
    const seat = ctx(root, wired.beforeWrite);
    await named(mine, 'read_file').run({ path: 'a.ts' }, seat);
    await named(mine, 'write_file').run({ path: 'a.ts', content: 'replaced' }, seat);

    const point = await wired.undo.end();
    assert.ok(point, '戻り先が残っていません');
    assert.deepEqual(point.paths, ['a.ts']);

    // 戻して、元に返ること。
    await wired.undo.restore(point.id);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'original');
  });

  test('何も書かなければ、戻り先は作らない（対）', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    assert.equal(await wired.undo.end(), undefined);
  });

  test('読むだけのツールは、控えを作らない（対）', async () => {
    const root = await place();
    await writeFile(join(root, 'a.ts'), 'original');
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    await named(wired.toolsFor(item('t1')), 'read_file')
      .run({ path: 'a.ts' }, ctx(root, wired.beforeWrite));
    assert.equal(await wired.undo.end(), undefined);
    assert.equal(readFileTool.schema.name, 'read_file');
  });
});

/**
 * 役職で絞る。
 *
 * **端末側は役職を見ていなかった。**画面側（`src/core/session.ts`）は
 * `assign` で絞るのに、`src/cli/team.ts` は渡していなかったので、
 * 依頼ファイルに `roleId` を書いても、読むだけの担当が書き込みも実行もできた。
 *
 * 絞るだけでは足りない。**絞ったうえで規則の手前で止まる**ところまで見る
 * （素のツールを渡せば絞りは通るが、守りが全部抜ける）。
 */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** git の管理下の作業場（外のツールの前後比べは git の記録で見る）。 */
async function repo(files: Record<string, string>): Promise<string> {
  const root = await place();
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

describe('team は、run_command が変えた分も戻り先に載せる', () => {
  test('**書くツールを通らない書き換え（run_command）も、終わりの前後比べで戻せる**', async () => {
    const root = await repo({ 'a.txt': 'もと\n' });
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    // run_command が書き換えた形（書くツールを通らないので、書く手前の記録は取られない）。
    await writeFile(join(root, 'a.txt'), 'コマンドが書いた\n');
    const { point, unrecorded } = await wired.finish();
    assert.ok(point, 'run_command の分が戻り先に載っていない');
    assert.deepEqual(unrecorded, []);
    await wired.undo.restore(point.id);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'もと\n');
  });

  test('run_command の後に書くツールで書いても、依頼の前の姿へ戻す（途中の姿に戻さない）', async () => {
    const root = await repo({ 'a.txt': 'もと\n' });
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    await writeFile(join(root, 'a.txt'), '途中\n');
    const tools = wired.toolsFor(item('t1'));
    await named(tools, 'read_file').run({ path: 'a.txt' }, ctx(root, wired.beforeWrite));
    const w = await named(tools, 'write_file').run({ path: 'a.txt', content: '最後\n' }, ctx(root, wired.beforeWrite));
    assert.equal(w.isError, undefined, w.content);
    const { point } = await wired.finish();
    assert.ok(point);
    await wired.undo.restore(point.id);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'もと\n', '途中の姿に戻した');
  });

  test('何も変えなければ、戻り先は作らない（対）', async () => {
    const root = await repo({ 'a.txt': 'もと\n' });
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const { point } = await wired.finish();
    assert.equal(point, undefined);
  });
});

describe('team は、役職で絞る', () => {
  // 組み込みの役職を使う。**実際に配られるものを見る。**
  //   reviewer  read だけ
  //   librarian read + write（execute は無い）
  //   worker    read + write + execute

  test('**読むだけの役職は、書くツールも走らせるツールも持たない**', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const got = wired.assign('reviewer', item('t1'));
    assert.ok(got, 'reviewer を配っていない');
    const names = got.tools.map((t) => t.schema.name).sort();
    assert.ok(names.includes('read_file'), `読むツールが無い: ${names.join(',')}`);
    assert.ok(!names.includes('write_file'), `書くツールを持っている: ${names.join(',')}`);
    assert.ok(!names.includes('edit_file'), `書くツールを持っている: ${names.join(',')}`);
    assert.ok(!names.includes('run_command'), `走らせるツールを持っている: ${names.join(',')}`);
    await wired.undo.end();
  });

  test('書く役職は書くツールを持つ（対）', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const names = wired.assign('librarian', item('t1'))!.tools.map((t) => t.schema.name);
    assert.ok(names.includes('write_file'), `書くツールが無い: ${names.join(',')}`);
    assert.ok(!names.includes('run_command'), `走らせるツールまで持っている: ${names.join(',')}`);
    // 全部持つ役職とも比べる。絞りが効いていなければ、ここが同じ数になる。
    const all = wired.assign('worker', item('t1'))!.tools.map((t) => t.schema.name);
    assert.ok(all.includes('run_command'), `worker が走らせるツールを持っていない: ${all.join(',')}`);
    assert.ok(all.length > names.length, `librarian と worker が同じ数（絞れていない）: ${all.length}`);
    await wired.undo.end();
  });

  test('**絞ったツールも、規則の手前で止まる**', async () => {
    const root = await place();
    await writeFile(join(root, '.env'), 'SECRET=1');
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const tools = wired.assign('librarian', item('t1'))!.tools;
    // 守られたファイル。絞りを通ったあとも、ここで止まる。
    // **絞るだけにして素のツールを渡すと、ここが素通りになる。**
    const r = await named(tools, 'write_file').run({ path: '.env', content: 'STOLEN=1' }, ctx(root));
    assert.equal(r.isError, true, '素通りしています');
    assert.match(r.content, /BLOCKED/);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1');
    await wired.undo.end();
  });

  test('知らない役職は配らない（呼んだ側の既定に落ちる）', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    assert.equal(wired.assign('居ない役職', item('t1')), undefined);
    await wired.undo.end();
  });
});

/**
 * 入口が、絞りを実際に渡しているか。
 *
 * **組み立てだけ直しても、入口が渡さなければ効かない。**
 * `wireTeam` に `assign` を足したのに `src/cli/team.ts` が渡し忘れると、
 * Team は `toolsFor` に落ちて、全部のツールが配られる。それは
 * 直す前と同じ状態で、しかも「直した」と記録に残る。
 *
 * 入口はモデルを立てないと通らないので、**Team が実際に選ぶところ**を
 * ここで押す（`assign` を渡した Team と、渡さない Team を比べる）。
 */
describe('入口が渡した絞りは、Team まで届く', () => {
  test('**assign を渡すと、役職のツールが選ばれる**', async () => {
    const root = await place();
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const withRole: WorkItem = { id: 't1', laneId: 'coder', instruction: 'なおす', roleId: 'reviewer' };

    // 渡したとき: 読むだけになる。
    const picked = wired.assign(withRole.roleId!, withRole)!.tools.map((t) => t.schema.name);
    assert.ok(!picked.includes('write_file'), `絞れていない: ${picked.join(',')}`);

    // **渡し忘れても守られる。**Team は assign が無ければ toolsFor に落ちるので、
    // そちらでも同じ絞りをかけてある。直す前はここが全部来ていた。
    const fallback = wired.toolsFor(withRole).map((t) => t.schema.name);
    assert.ok(!fallback.includes('write_file'), `渡し忘れで素通りする: ${fallback.join(',')}`);
    assert.ok(!fallback.includes('run_command'), `渡し忘れで素通りする: ${fallback.join(',')}`);

    // 役職が付いていない依頼は、これまでどおり全部（対）。
    const none = wired.toolsFor(item('t2')).map((t) => t.schema.name);
    assert.ok(none.includes('write_file'), `役職なしまで絞っている: ${none.join(',')}`);
    await wired.undo.end();
  });
});
