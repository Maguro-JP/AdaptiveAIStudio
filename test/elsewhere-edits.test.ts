/**
 * 段取りと Team の「戻す」に、利用者が作業の間に書いた分を載せない（日報 2026-10-06 の優先 2）。
 *
 * 外で変わったものは、依頼の始めと終わりの前後比べで取る。それだけだと、その間に利用者が別の画面で保存したファイルも
 * 依頼が変えたものとして「戻す」に載り、戻すと利用者の書いた分が消えた。外のツールを呼ぶたびに前後を比べ（`ToolWindows`）、
 * 書くツールでも外のツールでもない道は「よそで変わった」として載せない。
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { ToolWindows } from '../src/agent/outside-changes.ts';
import { wireTeam } from '../src/core/team-setup.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import type { Tool, ToolContext } from '../src/agent/tools/types.ts';
import type { WorkItem } from '../src/agent/team.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repo(files: Record<string, string>): Promise<string> {
  const home = await tempDir('aas-elsewhere-');
  const root = join(home, 'project');
  await mkdir(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

const writer = (name: string, body: string): Tool => ({
  schema: { name: 'run_command', description: 'x', parameters: { type: 'object', properties: {} } },
  run: async (_args, c) => { await writeFile(join(c.root, name), body); return { content: 'ok' }; },
});

describe('外のツールが走っている間に変わった道', () => {
  test('**包んだツールが変えた道だけを覚える**', async () => {
    const root = await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const windows = new ToolWindows(root);
    await windows.wrap(writer('a.txt', 'changed\n')).run({}, ctx(root));
    await writeFile(join(root, 'b.txt'), '利用者\n'); // 包みの外で変わった
    assert.equal(windows.mayHaveTouched('a.txt'), true);
    assert.equal(windows.mayHaveTouched('b.txt'), false);
  });

  test('git の管理下でなく比べられないときは、どれも外のツールの分とみなす（前と同じ）', async () => {
    const root = await tempDir('aas-elsewhere-nogit-');
    const windows = new ToolWindows(root);
    await windows.wrap(writer('a.txt', 'x\n')).run({}, ctx(root));
    assert.equal(windows.mayHaveTouched('anything.txt'), true);
  });
});

describe('Team', () => {
  const state = { dir: '' };
  afterEach(() => { delete process.env.AAS_STATE_DIR; });

  test('**作業の間に利用者が書いたファイルは「戻す」に載せず、戻しても利用者の分を消さない**', async () => {
    state.dir = await tempDir('aas-elsewhere-state-');
    process.env.AAS_STATE_DIR = state.dir;
    const root = await repo({ 'cmd.txt': 'もと\n', 'mine.txt': 'もと\n' });
    const wired = await wireTeam(DEFAULT_CONFIG, root);
    const item: WorkItem = { id: 't1', laneId: 'coder', instruction: 'x' };
    const run = wired.toolsFor(item).find((t) => t.schema.name === 'run_command')!;
    const ran = await run.run({ command: `node -e "require('fs').writeFileSync('cmd.txt','コマンド\\n')"` }, ctx(root));
    assert.notEqual(ran.isError, true, ran.content);
    await writeFile(join(root, 'mine.txt'), '利用者が書いた\n');

    const { point, elsewhere } = await wired.finish();
    assert.ok(point, 'run_command の分の戻り先が無い');
    assert.deepEqual([...point.paths], ['cmd.txt']);
    assert.deepEqual(elsewhere, ['mine.txt']);
    await wired.undo.restore(point.id);
    assert.equal(await readFile(join(root, 'cmd.txt'), 'utf8'), 'もと\n');
    assert.equal(await readFile(join(root, 'mine.txt'), 'utf8'), '利用者が書いた\n', '利用者の書いた分を消した');
  });
});

describe('段取り', { timeout: 90_000 }, () => {
  let fake: FakeServer;
  before(async () => { fake = await startFakeServer({ kind: 'stream', text: 'はい。' }); });
  after(async () => { await fake.close(); });

  test('**段取りの間に利用者が書いたファイルは「戻す」に載せない**', async () => {
    process.env.AAS_STATE_DIR = await tempDir('aas-elsewhere-plan-state-');
    const { Session } = await import('../src/core/session.ts');
    const root = await repo({ 'note.txt': 'もと\n', 'mine.txt': 'もと\n' });
    const session = await Session.create({
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 3, verify: { enabled: false } },
      initiative: { enabled: false },
    } as never, { approve: () => Promise.resolve(true) });
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [{ name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('note.txt','上書き\\n')"` } }],
        then: '書きました。',
      });
      let wrote = false;
      for await (const ev of session.plan('note.txt を書き換えて')) {
        // 担当が走り始めたところで、利用者が別の画面で保存する
        if (!wrote && ev.type === 'taskStart') { wrote = true; await writeFile(join(root, 'mine.txt'), '利用者が書いた\n'); }
      }
      assert.ok(wrote, '前提: 担当が走っていない');
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n', '前提: run_command が書いていない');
      const [point] = await session.undo.list();
      assert.ok(point, '戻り先が無い');
      assert.deepEqual([...point.paths], ['note.txt'], `利用者の分まで載った: ${point.paths.join(',')}`);
      await session.undo.restore(point.id);
      assert.equal(await readFile(join(root, 'mine.txt'), 'utf8'), '利用者が書いた\n');
    } finally {
      await session.close();
      delete process.env.AAS_STATE_DIR;
    }
  });
});
