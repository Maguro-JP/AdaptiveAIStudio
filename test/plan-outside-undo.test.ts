/**
 * 段取り（plan）でも、`run_command` と外のツール（MCP）が変えた分を「戻す」に載せる。
 *
 * 送り口（send）はツールの前後で作業場を比べて載せていたが、段取りの経路は
 * `beforeWrite`（この場所の書くツールだけ）しか通っていなかった。担当が `run_command`
 * で書いたファイルは、「戻す」を押しても戻らなかった。
 *
 * 段取りの分解は JSON でない返事なら 1 件の作業に落ちる（既定の担当 worker は
 * `run_command` を持ち、MCP は持たない）ので、fake-server の `steps` で担当に
 * `run_command` を呼ばせる。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-plan-outside-state-');
const { Session } = await import('../src/core/session.ts');

let fake: FakeServer;
before(async () => { fake = await startFakeServer({ kind: 'stream', text: 'はい。' }); });
after(async () => { await fake.close(); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function workspace(): Promise<string> {
  const home = await tempDir('aas-plan-outside-');
  const root = join(home, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'note.txt'), 'もとの中身\n');
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

async function open(root: string) {
  return Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 3 },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('段取りで run_command が変えた分も「戻す」に載る', { timeout: 90_000 }, () => {
  test('run_command で書き換えたファイルは元へ、作ったファイルは消える', async () => {
    const root = await workspace();
    const session = await open(root);
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [
          // `;` で繋ぐと二つのコマンドとして読まれ、後ろが許可外で断られる。一手に一つ。
          { name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('note.txt','上書き\\n')"` } },
          { name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('made.txt','作った\\n')"` } },
        ],
        then: '書きました。',
      });
      const seen: string[] = [];
      const work: string[] = [];
      for await (const ev of session.plan('note.txt を書き換えて')) {
        seen.push(ev.type);
        if (ev.type === 'work') work.push(`${ev.ok ? 'ok' : 'NG'} ${ev.text}`);
      }
      assert.ok(seen.includes('planned'), `段取りが走っていない: ${seen.join(',')}`);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n', `前提: run_command が書いていない: ${work.join(' / ')}`);
      assert.equal(await exists(join(root, 'made.txt')), true, '前提: run_command が作っていない');

      const [point] = await session.undo.list();
      assert.ok(point, '戻り先が無い');
      assert.deepEqual([...point.paths].sort(), ['made.txt', 'note.txt'], `run_command の分が戻り先に載っていない: ${point.paths.join(',')}`);
      await session.undo.restore(point.id);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もとの中身\n');
      assert.equal(await exists(join(root, 'made.txt')), false, 'run_command が作ったファイルが残っている');
    } finally {
      await session.close();
    }
  });

  test('先に run_command が変え、後で write_file が書いたファイルも、依頼の前の姿に戻る', async () => {
    // 書く手前の記録（beforeWrite）は run_command の後の姿。最初の一度が勝つままだと、途中の姿に戻る。
    const root = await workspace();
    const session = await open(root);
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [
          { name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('note.txt','途中\\n')"` } },
          { name: 'read_file', args: { path: 'note.txt' } },
          { name: 'write_file', args: { path: 'note.txt', content: '最後\n' } },
        ],
        then: '書きました。',
      });
      const work: string[] = [];
      for await (const ev of session.plan('note.txt を書き換えて')) {
        if (ev.type === 'work') work.push(`${ev.ok ? 'ok' : 'NG'} ${ev.text}`);
      }
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '最後\n', `前提: 書けていない: ${work.join(' / ')}`);
      const [point] = await session.undo.list();
      assert.ok(point, '戻り先が無い');
      await session.undo.restore(point.id);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もとの中身\n', 'run_command の後の途中の姿に戻っている');
    } finally {
      await session.close();
    }
  });
});
