/**
 * 外のツール（MCP）だけで書いて終わった回も、確かめる。
 *
 * 作業後の確かめは、この場所のツールで書く手前に作業前の成否を測った回だけ
 * 回っていた。MCP で書いて終わった回は、何も確かめずに「完了」になっていた。
 *
 * 作業場が変わっていたら、一度だけ確かめる（直させない）。読むだけの回では
 * 走らせない。どちらも、テストが走った跡（走るたびに1行増えるファイル）で見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, appendFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import type { Session as SessionT, SessionEvent } from '../src/core/session.ts';
import type { AasConfig } from '../src/config.ts';

// 了解の記憶・戻り先・索引を、試験専用の場所へ（本物の保存先を汚さない）。
// **読み込む前に**移す。索引（find.ts）は読み込んだ時点で保存先を決めるので、後から移しても効かない。
const stateDir = await tempDir('aas-outside-state-');
process.env.AAS_STATE_DIR = stateDir;
const { Session } = await import('../src/core/session.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { AckStore } = await import('../src/core/acks.ts');

const FIXTURE = join(import.meta.dirname, 'fixtures', 'writer-mcp.mjs');

let fake: FakeServer;
before(async () => {
  fake = await startFakeServer({ kind: 'stream', text: 'はい。' });
});
after(async () => { await fake.close(); });

/**
 * 作業場を一つ作る。テストは「走ったことを一つ上のファイルに1行足し、FAIL が在れば落ちる」だけ。
 * **そのファイルは作業場の外に置く。**中に置くと、テストが走ったこと自体が作業場の変化になる。
 */
async function workspace(opts: { git: boolean; failing?: boolean }): Promise<{ root: string; marker: string }> {
  const home = await tempDir('aas-outside-');
  const root = join(home, 'project');
  const marker = join(home, 'ran.txt');
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'a.test.ts'), "test('one', () => {});\ntest('two', () => {});\n");
  await writeFile(join(root, 'note.txt'), 'もとの中身\n');
  // 作業の前から落ちている作業場（対を作るため）。
  if (opts.failing) await writeFile(join(root, 'FAIL'), 'x');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0',
    // HANG が在れば止まらない（時間切れの回を作るため）。
    scripts: { test: `node -e "const f=require('fs');f.appendFileSync('../ran.txt','x\\n');if(f.existsSync('HANG'))setTimeout(()=>{},30000);else if(f.existsSync('FAIL'))process.exit(1)"` },
  }));
  if (opts.git) {
    git(root, 'init', '-q');
    // 走らせる環境の設定（Windows の autocrlf=true など）で戻る姿が変わらないように、ここで決める。
    git(root, 'config', 'core.autocrlf', 'false');
    commit(root);
  }
  return { root, marker };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function commit(root: string): void {
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
}

async function ranCount(marker: string): Promise<number> {
  const raw = await readFile(marker, 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.length > 0).length;
}

type Extra = { maxRounds?: number; rollback?: boolean; commandTimeoutMs?: number };

function config(root: string, extra: Extra = {}): AasConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    agent: {
      root, approval: 'auto',
      ...(extra.maxRounds || extra.commandTimeoutMs
        ? { verify: { ...(extra.maxRounds ? { maxRounds: extra.maxRounds } : {}), ...(extra.commandTimeoutMs ? { commandTimeoutMs: extra.commandTimeoutMs } : {}) } }
        : {}),
    },
    ...(extra.rollback ? { harness: { rollbackOnGiveUp: true } } : {}),
    mcp: { servers: { w: { command: process.execPath, args: [FIXTURE], startupTimeoutMs: 20_000 } } },
  } as AasConfig;
}

/** MCP のツールが揃うまで待つ。繋がる前に送ると、模型の呼んだ名前が無い。 */
async function ready(session: SessionT): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (session.toolPool.mcp.some((t) => t.schema.name === 'w__write')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('MCP のツールが揃いませんでした');
}

async function ask(session: SessionT, text: string): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const ev of session.send(text)) seen.push(ev);
  return seen;
}

type Behavior = Parameters<FakeServer['setBehavior']>[0];

async function turn(root: string, behavior: Behavior, extra: Extra = {}): Promise<SessionEvent[]> {
  const [seen] = await turns(root, [behavior], extra);
  return seen!;
}

/**
 * 同じ Session で、続けて何回か送る。
 *
 * 作業前の成否（ベースライン）は Session が覚えるので、「前の回で測ったもの」を
 * 使う道は一つの Session の中でしか試せない。fake-server の `steps` は履歴のツールの
 * 数で段を決めるので、回ごとに履歴を空にする（`reset`。覚えたものは残る）。
 */
async function turns(root: string, behaviors: Behavior[], extra: Extra = {}): Promise<SessionEvent[][]> {
  const session = await Session.create(config(root, extra), { approve: () => Promise.resolve(true) });
  const out: SessionEvent[][] = [];
  try {
    await ready(session);
    for (const b of behaviors) {
      session.reset();
      fake.setBehavior(b);
      out.push(await ask(session, 'やって'));
    }
    return out;
  } finally { await session.close(); }
}

const verifyTypes = (seen: SessionEvent[]) =>
  seen.flatMap((e) => (e.type === 'verify' ? [e.event.type] : []));
const outside = (seen: SessionEvent[]) =>
  seen.find((e): e is Extract<SessionEvent, { type: 'outsideChanged' }> => e.type === 'outsideChanged');
const rolledBack = (seen: SessionEvent[]) =>
  seen.find((e): e is Extract<SessionEvent, { type: 'rolledBack' }> => e.type === 'rolledBack');
const settledOf = (seen: SessionEvent[]) =>
  seen.find((e) => e.type === 'settled') as { checked?: string } | undefined;
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('外のツールだけで書いた回', { timeout: 60_000 }, () => {
  test('作業場が変わったら、一度だけ確かめる', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'new.txt'), content: 'MCP で書いた\n' }, then: '書きました。',
    });
    assert.deepEqual(outside(seen)?.paths, ['new.txt'], `変わったファイルを挙げていない: ${JSON.stringify(outside(seen))}`);
    assert.equal(await ranCount(marker), 1, '確かめが一度だけ走っていない');
    assert.deepEqual(verifyTypes(seen), ['running', 'passed']);
  });

  test('読むだけなら、走らせない（対）', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, { kind: 'toolcall', name: 'w__look', args: {}, then: '見ました。' });
    assert.equal(outside(seen), undefined, '変わっていないのに変わったと言っている');
    assert.equal(await ranCount(marker), 0, '読んだだけでテストが走っている');
    assert.deepEqual(verifyTypes(seen), []);
  });

  test('落ちても直させない。落ちたとは言うが、この回のせいとは言わない', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'FAIL'), content: 'x' }, then: '書きました。',
    });
    assert.deepEqual(verifyTypes(seen), ['running', 'failed'], '直させている、または落ちたと言っていない');
    assert.equal(await ranCount(marker), 1);
    const settled = seen.find((e) => e.type === 'settled') as { checked?: string } | undefined;
    // 作業前を測っていないので、この回のせいとは言えない。**失敗とも通ったとも言わない。**
    assert.equal(settled?.checked, 'unsure', `結末が「分からない」になっていない: ${settled?.checked}`);
  });

  test('テストを消して通したら、通ったとは言わない', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__remove',
      args: { path: join(root, 'test', 'a.test.ts') }, then: '消しました。',
    });
    assert.deepEqual(verifyTypes(seen), ['running', 'tampered'], `消したのに通っている: ${verifyTypes(seen).join(',')}`);
  });

  test('比べられない作業場では、比べられないと言い、走らせない', async () => {
    const { root, marker } = await workspace({ git: false });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'new.txt'), content: 'x' }, then: '書きました。',
    });
    const ev = outside(seen);
    assert.ok(ev, '比べられないのに黙っている');
    assert.equal(ev.paths, undefined);
    assert.equal(ev.ackable, 'outside-uncomparable', '了解の口が無い');
    assert.equal(await ranCount(marker), 0);
  });

  test('了解した作業場では、次から言わない。別の作業場では言う', async () => {
    const { root } = await workspace({ git: false });
    const write: Behavior = { kind: 'toolcall', name: 'w__write', args: { path: join(root, 'new.txt'), content: 'x' }, then: '書きました。' };
    assert.ok(outside(await turn(root, write))?.ackable, '了解の前なのに出ていない');
    await new AckStore(join(stateDir, 'acks.json')).add('outside-uncomparable', root);
    assert.equal(outside(await turn(root, write)), undefined, '了解したのにまた出ている');
    const other = await workspace({ git: false });
    const w2: Behavior = { kind: 'toolcall', name: 'w__write', args: { path: join(other.root, 'new.txt'), content: 'x' }, then: '書きました。' };
    assert.ok(outside(await turn(other.root, w2))?.ackable, '別の作業場まで了解したことにしている');
  });
});

/*
 * 外のツールが先に作業場を変え、そのあとこの場所のツールで書く回。
 *
 * 作業前の成否は、この場所のツールで書く手前で測る。外のツールの後に測ると、
 * 外のツールが落とした分まで「作業前から落ちていた」と読み、直させなかった。
 */
describe('外のツールが先に変えてから、この場所で書いた回', { timeout: 60_000 }, () => {
  const writeHere = [
    { name: 'read_file', args: { path: 'note.txt' } },
    { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
  ];

  test('外のツールが落とした分を、作業前からとは言わない', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1 });
    const ev = outside(seen);
    assert.ok(ev?.beforeBaseline, `先に変わったことを言っていない: ${JSON.stringify(ev)}`);
    assert.deepEqual(ev.paths, ['FAIL']);
    assert.ok(!seen.some((e) => e.type === 'baseline'), '外のツールの後に「作業前」を測っている');
    assert.ok(!verifyTypes(seen).includes('preexisting'), `外のツールが落とした分を、作業前からと言っている: ${verifyTypes(seen).join(',')}`);
    assert.ok(verifyTypes(seen).includes('failed'), '落ちたと言っていない');
  });

  test('外のツールが読んだだけなら、これまでどおり作業前を測る（対）', async () => {
    const { root } = await workspace({ git: true, failing: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__look', args: {} }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1 });
    assert.equal(outside(seen), undefined, '変わっていないのに変わったと言っている');
    assert.ok(seen.some((e) => e.type === 'baseline'), '作業前を測っていない');
    assert.ok(verifyTypes(seen).includes('preexisting'), `元から落ちていたものを、元からと言っていない: ${verifyTypes(seen).join(',')}`);
  });
});

/*
 * 打ち切って巻き戻すなら、外のツールが変えた分も戻す。
 *
 * この場所で書いた分だけ戻して外のツールの分が残ると、半分だけ戻った作業場になる。
 * `rollbackOnGiveUp` を付けた Session で、本当に元の中身に戻ることを見る。
 */
describe('打ち切ったら、外のツールが変えた分も戻す', { timeout: 60_000 }, () => {
  const writeHere = [
    { name: 'read_file', args: { path: 'note.txt' } },
    { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
  ];

  test('外のツールが作ったファイルは消え、この場所で書いたファイルは元に戻る', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1, rollback: true });
    const rb = rolledBack(seen);
    assert.ok(rb, `巻き戻していない: ${verifyTypes(seen).join(',')}`);
    assert.deepEqual([...rb.paths].sort(), ['FAIL', 'note.txt']);
    assert.equal(await exists(join(root, 'FAIL')), false, '外のツールが作ったファイルが残っている');
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もとの中身\n');
  });

  test('呼ぶ前から手で直していたファイルは、手で直した姿に戻る（索引の姿ではない）', async () => {
    const { root } = await workspace({ git: true });
    await appendFile(join(root, 'note.txt'), '手で直した\n');
    const seen = await turn(root, {
      kind: 'steps',
      calls: [
        { name: 'w__write', args: { path: join(root, 'note.txt'), content: 'MCP が上書き\n' } },
        { name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } },
        { name: 'read_file', args: { path: 'note.txt' } },
        { name: 'write_file', args: { path: 'note.txt', content: 'ここで書いた\n' } },
      ],
      then: '書きました。',
    }, { maxRounds: 1, rollback: true });
    assert.ok(rolledBack(seen), '巻き戻していない');
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もとの中身\n手で直した\n');
    assert.equal(await exists(join(root, 'FAIL')), false);
  });

  test('外のツールだけの回でテストを消したら、消したテストが戻る', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__remove',
      args: { path: join(root, 'test', 'a.test.ts') }, then: '消しました。',
    }, { rollback: true });
    assert.ok(verifyTypes(seen).includes('tampered'));
    assert.deepEqual(rolledBack(seen)?.paths, ['test/a.test.ts']);
    assert.equal(await readFile(join(root, 'test', 'a.test.ts'), 'utf8'), "test('one', () => {});\ntest('two', () => {});\n");
  });

  test('巻き戻さない設定なら、外のツールの分も含めて何も戻さない（対）', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1 });
    assert.equal(rolledBack(seen), undefined);
    assert.equal(await exists(join(root, 'FAIL')), true);
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '書き換えました\n');
  });
});

/*
 * この回より前に測った作業前の成否を覚えていれば、外のツールが先に変えていても使う。
 *
 * 覚えているものは、外のツールが触る前の姿。走らせずに「元から落ちていたか」を判じられる。
 */
describe('覚えている作業前を使う', { timeout: 90_000 }, () => {
  const writeHere: Behavior = {
    kind: 'steps',
    calls: [
      { name: 'read_file', args: { path: 'note.txt' } },
      { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
    ],
    then: '書きました。',
  };

  test('元から落ちている作業場で、外のツールが先に変えても、元からと言える', async () => {
    const { root } = await workspace({ git: true, failing: true });
    const [first, second] = await turns(root, [
      writeHere,
      {
        kind: 'steps',
        calls: [{ name: 'w__write', args: { path: join(root, 'new.txt'), content: 'x' } },
          { name: 'read_file', args: { path: 'note.txt' } },
          { name: 'write_file', args: { path: 'note.txt', content: '二度目\n' } }],
        then: '書きました。',
      },
    ], { maxRounds: 1 });
    assert.ok(verifyTypes(first!).includes('preexisting'), `一回目で作業前を測っていない: ${verifyTypes(first!).join(',')}`);
    const ev = outside(second!);
    assert.ok(ev?.beforeBaseline && ev.remembered, `覚えているものを使っていない: ${JSON.stringify(ev)}`);
    const base = second!.find((e) => e.type === 'baseline') as { cached?: boolean } | undefined;
    assert.equal(base?.cached, true, '走らせずに使ったことになっていない');
    assert.ok(verifyTypes(second!).includes('preexisting'), `元からの失敗を、この回のせいにしている: ${verifyTypes(second!).join(',')}`);
  });

  test('元から落ちている作業場で、外のツールがテストを消したら、元からとは言わずに失敗にする（DECISIONS 10-11、109 回目）', async () => {
    const { root } = await workspace({ git: true, failing: true });
    const [first, second] = await turns(root, [
      writeHere,
      { kind: 'toolcall', name: 'w__remove', args: { path: join(root, 'test', 'a.test.ts') }, then: '消しました。' },
    ], { maxRounds: 1 });
    assert.ok(verifyTypes(first!).includes('preexisting'), `一回目で作業前を測っていない: ${verifyTypes(first!).join(',')}`);
    assert.ok(verifyTypes(second!).includes('tampered'), `テストを消したのに数を比べていない: ${verifyTypes(second!).join(',')}`);
    assert.ok(!verifyTypes(second!).includes('preexisting'), 'テストを消した回を、作業前からの失敗と言った');
  });

  test('前は通っていたのに外のツールだけの回で落ちたら、外のツールのせいとして巻き戻す', async () => {
    const { root } = await workspace({ git: true });
    const [first, second] = await turns(root, [
      writeHere,
      { kind: 'toolcall', name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' }, then: '書きました。' },
    ], { maxRounds: 1, rollback: true });
    assert.ok(verifyTypes(first!).includes('passed'));
    assert.equal(settledOf(second!)?.checked, 'failed', `覚えている「前」が通っているのに、分からないにしている: ${settledOf(second!)?.checked}`);
    assert.deepEqual(rolledBack(second!)?.paths, ['FAIL']);
    assert.equal(await exists(join(root, 'FAIL')), false);
  });
});

/*
 * 覚えている「前」は、回の終わりの姿に書き直す。
 *
 * 一回目で作業場を落ちる姿のまま終えた（巻き戻さない設定）なら、次の回の「前」はその姿。
 * 一回目の作業前（通っていた）を覚えたままだと、二回目の外のツールだけの回で
 * 「前は通っていたのに落ちた」と、外のツールのせいにして巻き戻す。
 */
describe('覚えている作業前を、回の終わりに書き直す', { timeout: 90_000 }, () => {
  const writeHere: Behavior = {
    kind: 'steps',
    calls: [
      { name: 'read_file', args: { path: 'note.txt' } },
      { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
    ],
    then: '書きました。',
  };

  test('前の回で落としたまま終えたなら、次の回はその落ち方を「元から」と言う', async () => {
    const { root } = await workspace({ git: true });
    const [first, second] = await turns(root, [
      { kind: 'steps', calls: [{ name: 'write_file', args: { path: 'FAIL', content: 'x' } }], then: '書きました。' },
      { kind: 'toolcall', name: 'w__write', args: { path: join(root, 'new.txt'), content: 'x' }, then: '書きました。' },
    ], { maxRounds: 1 });
    assert.ok(verifyTypes(first!).includes('failed'), `一回目で壊れていない: ${verifyTypes(first!).join(',')}`);
    assert.equal(settledOf(second!)?.checked, 'preexisting',
      `前の回で落とした分を、外のツールのせいにしている: ${settledOf(second!)?.checked}`);
  });

  test('大きすぎて前の中身を記録できなかったものは、戻せなかったと言い、覚えている「前」を捨てる', async () => {
    const { root } = await workspace({ git: true });
    // HEAD に在る大きなファイル（記録の上限 8MiB を超える）。
    await writeFile(join(root, 'big.bin'), Buffer.alloc(9 * 1024 * 1024, 0x61));
    commit(root);
    const [first, second] = await turns(root, [
      writeHere,
      {
        kind: 'steps',
        calls: [
          { name: 'w__write', args: { path: join(root, 'big.bin'), content: 'small' } },
          { name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } },
        ],
        then: '書きました。',
      },
    ], { maxRounds: 1, rollback: true });
    assert.ok(verifyTypes(first!).includes('passed'));
    const rb = rolledBack(second!);
    assert.ok(rb, `巻き戻していない: ${verifyTypes(second!).join(',')}`);
    assert.deepEqual(rb.paths, ['FAIL']);
    assert.deepEqual(rb.notRestored, ['big.bin'], '戻せなかったものを言っていない');
    assert.equal(await exists(join(root, 'FAIL')), false);
    assert.equal((await stat(join(root, 'big.bin'))).size, 5, '戻せないものを戻したことにしている');
  });
});

/*
 * 読み直しで見つかった二つ。巻き戻した後の「前」を捨てていた／時間切れの途中の出力を「前」として覚えていた。
 */
describe('覚えている「前」の扱い（読み直しの指摘）', { timeout: 120_000 }, () => {
  const writeHere: Behavior = {
    kind: 'steps',
    calls: [
      { name: 'read_file', args: { path: 'note.txt' } },
      { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
    ],
    then: '書きました。',
  };

  test('外のツールだけの回を巻き戻しても「前」を覚えたまま。三回目も巻き戻す', async () => {
    const { root } = await workspace({ git: true });
    const mcpFail: Behavior = { kind: 'toolcall', name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' }, then: '書きました。' };
    const [, second, third] = await turns(root, [writeHere, mcpFail, mcpFail], { maxRounds: 1, rollback: true });
    assert.deepEqual(rolledBack(second!)?.paths, ['FAIL']);
    assert.equal(settledOf(third!)?.checked, 'failed', `三回目で「前」を忘れている: ${settledOf(third!)?.checked}`);
    assert.deepEqual(rolledBack(third!)?.paths, ['FAIL'], '三回目を巻き戻していない');
    assert.equal(await exists(join(root, 'FAIL')), false);
  });

  test('時間切れで打ち切った回の途中の出力を「前」として覚えない。次の回は分からないで持つ', async () => {
    const { root } = await workspace({ git: true });
    const [first, second] = await turns(root, [
      { kind: 'steps', calls: [
        { name: 'write_file', args: { path: 'FAIL', content: 'x' } },
        { name: 'write_file', args: { path: 'HANG', content: 'x' } }], then: '書きました。' },
      { kind: 'toolcall', name: 'w__remove', args: { path: join(root, 'HANG') }, then: '消しました。' },
    ], { maxRounds: 1, commandTimeoutMs: 1500 });
    assert.ok(verifyTypes(first!).includes('giveUp'), `一回目が時間切れで打ち切られていない: ${verifyTypes(first!).join(',')}`);
    // FAIL は一回目が残したもの。二回目の外のツールのせいにしない（覚えていないので「分からない」）。
    assert.equal(settledOf(second!)?.checked, 'unsure', `一回目が残した失敗を二回目のせいにしている: ${settledOf(second!)?.checked}`);
  });
});
