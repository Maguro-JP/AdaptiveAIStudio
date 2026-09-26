/**
 * `aas team` の入口（`src/cli/team.ts`）を、偽のモデルで端から端まで通す。
 *
 * 入口はモデルを立てないと通らないので、組み立て（`core/team-setup.ts`）だけを試していた。
 * 入口が `finish()` を呼ばずに閉じると、run_command が書き換えた分は戻り先に載らない。
 * 組み立ての試験はそれを止められないので、入口を子として起こして確かめる。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import { cleanAasEnv } from './env.ts';

let fake: FakeServer;
before(async () => {
  fake = await startFakeServer({
    kind: 'steps',
    // 書くツールを通らない書き換え（run_command）。書く手前の記録は取られない。
    calls: [{ name: 'run_command', args: { command: 'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'cmd\\n\')"' } }],
    then: '書き換えました',
  });
});
after(async () => { await fake.close(); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('aas team の入口', { timeout: 120_000 }, () => {
  test('**run_command が書き換えた分も、入口を通して戻り先に載る**', async () => {
    const dir = await tempDir('aas-team-cli-');
    const root = join(dir, 'work');
    const state = join(dir, 'state');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.txt'), 'もと\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

    const config = join(dir, 'aas.config.json');
    await writeFile(config, JSON.stringify({
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 4 },
    }));
    const tasks = join(dir, 'tasks.json');
    await writeFile(tasks, JSON.stringify([{ id: 't1', laneId: 'default', instruction: 'a.txt を書き換えて' }]));

    const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
    const at = join(installRoot(), 'src', 'cli', 'team.ts');
    const out = await promisify(execFile)(process.execPath, [...flags, '--no-warnings', at, tasks], {
      env: cleanAasEnv({ AAS_CONFIG: config, AAS_HOME: join(dir, 'home'), AAS_STATE_DIR: state, NO_COLOR: '1' }),
      timeout: 90_000,
    }).catch((e: { stdout?: string; stderr?: string }) => e);
    // eslint-disable-next-line no-control-regex
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'cmd\n', `前提: コマンドが書き換えていない:\n${text.slice(-800)}`);
    assert.match(text, /戻り先: /, `戻り先を出していない:\n${text.slice(-800)}`);
    const points = (await readdir(join(state, 'undo'))).filter((f) => f.endsWith('.json'));
    const stored = await Promise.all(points.map(async (f) => JSON.parse(await readFile(join(state, 'undo', f), 'utf8')) as { paths: string[] }));
    assert.ok(stored.some((p) => p.paths.includes('a.txt')), `run_command の分が戻り先に載っていない: ${JSON.stringify(stored)}`);
  });
});
