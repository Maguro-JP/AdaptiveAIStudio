/**
 * 戻り先を書けなかったとき、黙らない。
 *
 * 依頼の終わりに戻り先を閉じるところで、書き込みの失敗を黙って捨てていた。ファイルは書き換わったのに
 * 戻り先は残っておらず、利用者は「戻す」で戻せるつもりのまま次へ進む。
 *
 * 戻り先を置くフォルダ（`<state>/undo`）の名前でファイルを作り、フォルダを作れないようにする（権限に頼らない。root でも落ちる）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './tmp.ts';
import { UndoStore } from '../src/core/undo.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

const state = await tempDir('aas-undo-end-fails-state-');
process.env.AAS_STATE_DIR = state;
const { Session } = await import('../src/core/session.ts');

describe('UndoStore.end', () => {
  test('書けなければ投げる（呼ぶ側が「戻せません」と言えるように）', async () => {
    const root = await tempDir('aas-undo-end-fails-root-');
    const base = await tempDir('aas-undo-end-fails-dir-');
    const dir = join(base, 'undo');
    await writeFile(dir, 'フォルダではない\n');
    const undo = new UndoStore(root, dir);
    await undo.begin('書き換えて');
    undo.capture('a.txt', 'もと\n');
    await assert.rejects(undo.end());
  });

  test('何も触っていなければ、書かないので投げない', async () => {
    const root = await tempDir('aas-undo-end-fails-root-');
    const base = await tempDir('aas-undo-end-fails-dir-');
    const dir = join(base, 'undo');
    await writeFile(dir, 'フォルダではない\n');
    const undo = new UndoStore(root, dir);
    await undo.begin('読むだけ');
    assert.equal(await undo.end(), undefined);
  });
});

describe('依頼の終わりに戻り先を書けなかったとき', () => {
  let fake: FakeServer;
  before(async () => {
    fake = await startFakeServer({
      kind: 'steps',
      calls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'write_file', args: { path: 'a.txt', content: '書き換えました\n' } },
      ],
      then: '書き換えました。',
    });
  });
  after(async () => { await fake.close(); });

  test('書き換えは済ませたうえで、「戻す」からは戻せないと言う', async () => {
    const root = await tempDir('aas-undo-end-fails-work-');
    await writeFile(join(root, 'a.txt'), 'もとの中身\n');
    const logs: Array<{ level: string; text: string }> = [];
    const session = await Session.create({
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 4, verify: { enabled: false } },
      initiative: { enabled: false },
    } as never, {
      approve: () => Promise.resolve(true),
      onLog: (level, text) => logs.push({ level, text }),
    });
    await rm(join(state, 'undo'), { recursive: true, force: true });
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'undo'), 'フォルダではない\n');

    for await (const _ of session.send('a.txt を書き換えて')) { /* 流すだけ */ }

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '書き換えました\n', '書き換えが済んでいない（前提が崩れている）');
    const warned = logs.filter((l) => l.level === 'warn' && l.text.includes('戻り先を残せませんでした'));
    assert.equal(warned.length, 1, `戻り先を書けなかったことを言っていない:\n${logs.map((l) => `${l.level} ${l.text}`).join('\n')}`);
    assert.match(warned[0]!.text, /「戻す」からは戻せません/);
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 段取りの道は git の作業場で動かす（依頼の前後比べに使う）。 */
async function gitWorkspace(): Promise<string> {
  const root = join(await tempDir('aas-undo-end-fails-plan-'), 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'もとの中身\n');
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

/** 戻り先を置くフォルダの名前でファイルを作り、書けなくする。 */
async function blockUndoDir(): Promise<void> {
  await rm(join(state, 'undo'), { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'undo'), 'フォルダではない\n');
}

describe('段取り（plan）の終わりに戻り先を書けなかったとき', { timeout: 90_000 }, () => {
  let fake: FakeServer;
  before(async () => {
    fake = await startFakeServer({
      kind: 'steps',
      calls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'write_file', args: { path: 'a.txt', content: '書き換えました\n' } },
      ],
      then: '書き換えました。',
    });
  });
  after(async () => { await fake.close(); });

  async function open(root: string, extra: { verify?: string; rollback?: boolean } = {}) {
    const logs: Array<{ level: string; text: string }> = [];
    const session = await Session.create({
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'none' },
      agent: {
        root, approval: 'auto', maxTurns: 4,
        verify: extra.verify ? { command: extra.verify } : { enabled: false },
      },
      ...(extra.rollback ? { harness: { rollbackOnGiveUp: true } } : {}),
      initiative: { enabled: false },
    } as never, {
      approve: () => Promise.resolve(true),
      onLog: (level, text) => logs.push({ level, text }),
    });
    return { session, logs };
  }

  test('書き換えは済ませたうえで、「戻す」からは戻せないと言う', async () => {
    const root = await gitWorkspace();
    const { session, logs } = await open(root);
    try {
      await blockUndoDir();
      const seen: string[] = [];
      for await (const ev of session.plan('a.txt を書き換えて')) seen.push(ev.type);
      assert.ok(seen.includes('planned'), `段取りが走っていない: ${seen.join(',')}`);
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '書き換えました\n', '書き換えが済んでいない（前提が崩れている）');
      const warned = logs.filter((l) => l.level === 'warn' && l.text.includes('戻り先を残せませんでした'));
      assert.equal(warned.length, 1, `戻り先を書けなかったことを言っていない:\n${logs.map((l) => `${l.level} ${l.text}`).join('\n')}`);
    } finally {
      await session.close();
    }
  });

  test('確かめて落ちて自動で戻す回も、戻り先を残せず戻していないことを言う', async () => {
    const root = await gitWorkspace();
    const failsOnRewrite = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8').includes('書き換え')?1:0)"`;
    const { session } = await open(root, { verify: failsOnRewrite, rollback: true });
    try {
      await blockUndoDir();
      const said: string[] = [];
      for await (const ev of session.plan('a.txt を書き換えて')) {
        if (ev.type === 'log' && ev.level === 'warn') said.push(ev.text);
      }
      assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '書き換えました\n', '戻り先が無いのに戻っている（前提が崩れている）');
      assert.ok(said.some((t) => t.includes('戻り先を残せなかったので、自動では戻していません')), `自動で戻していないことを言っていない:\n${said.join('\n')}`);
    } finally {
      await session.close();
    }
  });
});
