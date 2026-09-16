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
