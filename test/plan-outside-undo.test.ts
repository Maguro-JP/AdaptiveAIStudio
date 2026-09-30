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
import { UndoStore } from '../src/core/undo.ts';
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

async function open(root: string, extra: { verify?: string; rollback?: boolean } = {}) {
  return Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: {
      root, approval: 'auto', maxTurns: 3,
      verify: extra.verify ? { command: extra.verify } : { enabled: false },
    },
    ...(extra.rollback ? { harness: { rollbackOnGiveUp: true } } : {}),
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
}

/** note.txt に「上書き」が入ると落ちる確かめ。作業の前は通る（切り分けで「前から落ちていた」にならない）。 */
const FAILS_ON_OVERWRITE = `node -e "process.exit(require('fs').readFileSync('note.txt','utf8').includes('上書き')?1:0)"`;

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

describe('段取りで確かめて落ちたら、この依頼の変更を全部戻す（harness.rollbackOnGiveUp）', { timeout: 90_000 }, () => {
  const steps = {
    kind: 'steps' as const,
    calls: [
      { name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('note.txt','上書き\\n')"` } },
      { name: 'write_file', args: { path: 'made.txt', content: '作った\n' } },
    ],
    then: '書きました。',
  };

  test('書くツールの分も run_command の分も、依頼の前の姿に戻り、戻したと言う', async () => {
    const root = await workspace();
    const session = await open(root, { verify: FAILS_ON_OVERWRITE, rollback: true });
    try {
      fake.setBehavior(steps);
      const seen: string[] = [];
      let rolled: { paths: string[]; notRestored?: string[] } | undefined;
      let verdict: string | undefined;
      for await (const ev of session.plan('note.txt を書き換えて')) {
        seen.push(ev.type);
        if (ev.type === 'rolledBack') rolled = ev;
        if (ev.type === 'accepted') verdict = ev.report.verified;
      }
      assert.equal(verdict, 'failed', `前提: 確かめが落ちていない: ${seen.join(',')}`);
      assert.ok(rolled, `戻したと言っていない: ${seen.join(',')}`);
      assert.deepEqual([...rolled.paths].sort(), ['made.txt', 'note.txt']);
      assert.equal(rolled.notRestored, undefined);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もとの中身\n', 'run_command の分が戻っていない');
      assert.equal(await exists(join(root, 'made.txt')), false, 'write_file で作ったファイルが残っている');
      // 戻した後に「戻す」を押しても、戻した姿を壊さない（この依頼の戻り先は使い切っている）。
      assert.ok(!(await session.undo.list()).some((p) => p.request.startsWith('note.txt を書き換えて') && p.paths.includes('made.txt')),
        'この依頼の戻り先が残っている');
    } finally {
      await session.close();
    }
  });

  /** 確かめのコマンドを遅くして、確かめの最中に手を入れる。落ちるのは note.txt に「上書き」があるとき。 */
  const SLOW_FAIL = `node -e "setTimeout(()=>process.exit(require('fs').readFileSync('note.txt','utf8').includes('上書き')?1:0),1500)"`;

  test('確かめの途中で止めたら、落ちたとは言えないので戻さない', async () => {
    const root = await workspace();
    const session = await open(root, { verify: SLOW_FAIL, rollback: true });
    try {
      fake.setBehavior(steps);
      const seen: string[] = [];
      let verifying = 0;
      for await (const ev of session.plan('note.txt を書き換えて')) {
        seen.push(ev.type);
        // 作業の前の確かめ（切り分け）と、終わりの確かめ。終わりの方で止める。
        if (ev.type === 'verifying' && ++verifying >= 1) setTimeout(() => session.abort(), 200);
      }
      assert.ok(!seen.includes('rolledBack'), `止めたのに戻した: ${seen.join(',')}`);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n');
    } finally {
      await session.close();
    }
  });

  test('この依頼の後に別の戻り先ができていたら、自動では戻さずに言う（別の作業まで戻さない）', async () => {
    const root = await workspace();
    const session = await open(root, { verify: SLOW_FAIL, rollback: true });
    try {
      fake.setBehavior(steps);
      const seen: string[] = [];
      const logs: string[] = [];
      for await (const ev of session.plan('note.txt を書き換えて')) {
        seen.push(ev.type);
        if (ev.type === 'log') logs.push(ev.text);
        if (ev.type === 'verifying') {
          // 同じ保存先を使う別の作業（別の Session や CLI）が、この依頼の後に戻り先を作って閉じた。
          const other = new UndoStore(root, join(process.env.AAS_STATE_DIR!, 'undo'));
          await writeFile(join(root, 'other.txt'), 'よそ\n');
          await other.begin('別の作業', Date.now() + 1000);
          other.capture('other.txt', undefined);
          await other.end();
        }
      }
      assert.ok(!seen.includes('rolledBack'), `別の戻り先があるのに戻した: ${seen.join(',')}`);
      assert.ok(logs.some((t) => t.includes('自動では戻していません')), `戻さなかったと言っていない: ${logs.join(' / ')}`);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n');
      assert.equal(await exists(join(root, 'other.txt')), true, '別の作業のファイルまで消した');
    } finally {
      await session.close();
    }
  });

  test('設定が無ければ戻さない（既定は git が守る。変更は「戻す」に残る）', async () => {
    const root = await workspace();
    const session = await open(root, { verify: FAILS_ON_OVERWRITE });
    try {
      fake.setBehavior(steps);
      // 状態の保存先は試験のあいだで共有なので、数は走らせる前後の差で見る（前の試験の残りに寄りかからない）。
      const before = (await session.undo.list()).length;
      const seen: string[] = [];
      for await (const ev of session.plan('note.txt を書き換えて')) seen.push(ev.type);
      assert.ok(!seen.includes('rolledBack'), '設定が無いのに戻している');
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n');
      assert.equal((await session.undo.list()).length, before + 1, '「戻す」に残っていない');
    } finally {
      await session.close();
    }
  });
});

describe('段取りの受け入れの報告に、run_command が変えた分も載る', { timeout: 90_000 }, () => {
  test('作業の前から手元で変えてあったファイルを run_command がさらに書き換えても、「変わったもの」に載る', async () => {
    const root = await workspace();
    // 作業の前から手元で変えてある（git の差分の名前だけで比べると、前にも後にも在るので載らない）
    await writeFile(join(root, 'note.txt'), '手元で変えた\n');
    const session = await open(root);
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [{ name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('note.txt','上書き\\n')"` } }],
        then: '書きました。',
      });
      let changed: string[] | undefined;
      for await (const ev of session.plan('note.txt を書き換えて')) {
        if (ev.type === 'accepted') changed = ev.report.changed;
      }
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '上書き\n', '前提: run_command が書いていない');
      assert.ok(changed, '受け入れの報告が出ていない');
      assert.ok(changed!.includes('note.txt'), `run_command が書き換えた分が載っていない: ${JSON.stringify(changed)}`);
    } finally {
      await session.close();
    }
  });
});

