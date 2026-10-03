/**
 * 自己検証ループの検証。
 * 通るまで回すこと、そして「テストを消して通す」を認めないことを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { verifyLoop, runVerification, digestFailure, feedbackFor, type VerifyEvent,
} from '../src/agent/verify.ts';
import { snapshotTests, compareTests } from '../src/agent/test-integrity.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-verify-');
  for (const [name, content] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

/** 実装ファイルの値を見て成否が決まる、最小のテストスクリプト。 */
const RUNNER = `
import { readFileSync } from 'node:fs';
const v = readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim();
if (v !== 'good') { console.error('assertion failed: expected good, got ' + v); process.exit(1); }
console.log('ok');
`;

const COMMAND = `node runner.mjs`;

async function drain(gen: AsyncGenerator<VerifyEvent, unknown>) {
  const events: VerifyEvent[] = [];
  let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }
  return { events, outcome: next.value as Awaited<ReturnType<typeof verifyLoop>> extends never ? never : any };
}

describe('検証の実行', () => {
  test('成功と失敗を終了コードで判定する', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    const bad = await runVerification({ command: COMMAND, root }, new AbortController().signal);
    assert.equal(bad.passed, false);
    assert.match(bad.output, /assertion failed/);

    await writeFile(join(root, 'value.txt'), 'good');
    const good = await runVerification({ command: COMMAND, root }, new AbortController().signal);
    assert.equal(good.passed, true);
  });

  test('タイムアウトを区別する', async () => {
    const root = await project({ 'slow.mjs': 'setTimeout(() => {}, 60000);' });
    const r = await runVerification(
      { command: 'node slow.mjs', root, commandTimeoutMs: 300 },
      new AbortController().signal,
    );
    assert.equal(r.timedOut, true);
    assert.equal(r.passed, false);
  });
});

describe('失敗の要約', () => {
  test('実行ごとに変わる値を落とし、同じ失敗を同じと判定できる', () => {
    const a = digestFailure('FAIL foo\n  duration 132 ms\n  at /tmp/abc123/x.ts');
    const b = digestFailure('FAIL foo\n  duration 987 ms\n  at /tmp/zzz999/x.ts');
    assert.equal(a, b, '同じ失敗が別物と判定される');
  });

  test('node:test の所要時間（数字が後ろ）も落とす', () => {
    // TAP（端末でないとき）と spec の形。数字が `duration_ms` の後ろに来る。
    const tap = (n: string, m: string) => digestFailure(`not ok 1 - x\n  ---\n  duration_ms: ${n}\n  ...\n# fail 1\n# duration_ms ${m}`);
    assert.equal(tap('1.371285', '125.619341'), tap('1.517393', '105.700819'));
    const spec = (m: string) => digestFailure(`✖ x\nℹ fail 1\nℹ duration_ms ${m}`);
    assert.equal(spec('101.25'), spec('98.7'));
  });

  test('Windows の一時フォルダも落とす', () => {
    const at = (dir: string) => digestFailure(`Error: ENOENT\n    at C:\\Users\\me\\AppData\\Local\\Temp\\${dir}\\x.ts:3:9`);
    assert.equal(at('aas-abc123'), at('aas-zzz999'));
    // 利用者名に空白が入っても落とす
    const spaced = (dir: string) => digestFailure(`    at C:\\Users\\John Smith\\AppData\\Local\\Temp\\${dir}\\x.ts:3:9`);
    assert.equal(spaced('aas-abc123'), spaced('aas-zzz999'));
    const doubled = (dir: string) => digestFailure(`path: 'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\${dir}\\\\x.ts'`);
    assert.equal(doubled('aas-abc123'), doubled('aas-zzz999'));
  });

  test('指示文にテスト削除の禁止が含まれる', () => {
    const text = feedbackFor(
      { passed: false, output: 'boom', durationMs: 1, timedOut: false }, 'npm test', 1);
    assert.match(text, /npm test/);
    assert.match(text, /削除・skip/);
  });
});

describe('ループ', () => {
  test('直せば通り、そこで止まる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    let fixes = 0;
    const gen = verifyLoop({ command: COMMAND, root }, async () => {
      fixes += 1;
      await writeFile(join(root, 'value.txt'), 'good'); // 作業者が直す
    }, new AbortController().signal);

    const { events, outcome } = await drain(gen);
    assert.equal(outcome.passed, true);
    assert.equal(outcome.rounds, 2, '通った後も回り続けている');
    assert.equal(fixes, 1);
    assert.ok(events.some((e) => e.type === 'failed'));
    assert.ok(events.some((e) => e.type === 'passed'));
  });

  test('最初から通っていれば1回で終わる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'good' });
    let fixes = 0;
    const { outcome } = await drain(verifyLoop(
      { command: COMMAND, root }, async () => { fixes += 1; }, new AbortController().signal));
    assert.equal(outcome.passed, true);
    assert.equal(outcome.rounds, 1);
    assert.equal(fixes, 0, '通っているのに直させている');
  });

  test('同じ失敗が3回続いたら打ち切る', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    let fixes = 0;
    const { events, outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 10 },
      async () => { fixes += 1; }, // 何も直さない
      new AbortController().signal,
    ));
    assert.equal(outcome.passed, false);
    assert.equal(outcome.rounds, 3, `無駄に回っている: ${outcome.rounds}回`);
    assert.ok(events.some((e) => e.type === 'giveUp' && e.reason === 'noProgress'));
    assert.equal(fixes, 2);
  });

  test('回数の上限で止まる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    let n = 0;
    // 毎回違う失敗にして進捗判定を回避する
    const { events, outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 2 },
      async () => { n += 1; await writeFile(join(root, 'value.txt'), `bad${n}`); },
      new AbortController().signal,
    ));
    assert.equal(outcome.passed, false);
    assert.ok(events.some((e) => e.type === 'giveUp' && e.reason === 'maxRounds'));
  });

  test('時間の上限で止まる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    const { events } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 10, timeBudgetMs: 1 },
      async () => { await new Promise((r) => setTimeout(r, 20)); },
      new AbortController().signal,
    ));
    assert.ok(events.some((e) => e.type === 'giveUp' && e.reason === 'timeBudget'));
  });

  test('中断できる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    const ac = new AbortController();
    ac.abort();
    const { events } = await drain(verifyLoop(
      { command: COMMAND, root }, async () => {}, ac.signal));
    assert.ok(events.some((e) => e.type === 'giveUp' && e.reason === 'aborted'));
  });
});

describe('テストの改ざん検出', () => {
  test('テストの件数を数える', async () => {
    const root = await project({
      'a.test.ts': 'test("x", () => {}); test("y", () => {});',
      'src/app.ts': 'export const x = 1;',
    });
    const snap = await snapshotTests(root);
    assert.equal(snap.totalFiles, 1);
    assert.equal(snap.totalCases, 2);
  });

  test('skip はテストとして数えない', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {}); test.skip("y", () => {});' });
    assert.equal((await snapshotTests(root)).totalCases, 1);
  });

  test('テストファイルの削除を検出する', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {});' });
    const before = await snapshotTests(root);
    await rm(join(root, 'a.test.ts'));
    const verdict = compareTests(before, await snapshotTests(root));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason!, /削除/);
  });

  test('テスト件数の減少を検出する', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {}); test("y", () => {});' });
    const before = await snapshotTests(root);
    await writeFile(join(root, 'a.test.ts'), 'test("x", () => {});');
    const verdict = compareTests(before, await snapshotTests(root));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason!, /減って/);
  });

  test('テストを増やすのは問題ない', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {});' });
    const before = await snapshotTests(root);
    await writeFile(join(root, 'a.test.ts'), 'test("x", () => {}); test("z", () => {});');
    assert.equal(compareTests(before, await snapshotTests(root)).ok, true);
  });

  test('テストを消して通しても、通過とみなさない', async () => {
    const root = await project({
      'runner.mjs': `
import { readdirSync } from 'node:fs';
const tests = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.ts'));
if (tests.length > 0) { console.error('failing test present'); process.exit(1); }
console.log('ok');
`,
      'a.test.ts': 'test("x", () => {});',
    });

    const { events, outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 2 },
      async () => { await rm(join(root, 'a.test.ts')); }, // テストを消して「直した」
      new AbortController().signal,
    ));

    assert.equal(outcome.passed, false, 'テストを消して通ってしまった');
    assert.ok(events.some((e) => e.type === 'tampered'), '改ざんを検出していない');
  });
});

describe('作業前からの失敗の切り分け', () => {
  test('作業前と同じ失敗なら、モデルに投げずに止める', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    const baseline = await runVerification({ command: COMMAND, root }, new AbortController().signal);

    let fixes = 0;
    const { events, outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 5 },
      async () => { fixes += 1; },
      new AbortController().signal,
      undefined,
      baseline,
    ));

    assert.equal(outcome.preexistingFailure, true);
    assert.equal(outcome.rounds, 1, '既存の失敗で無駄に回っている');
    assert.equal(fixes, 0, '直せない失敗をモデルに投げている');
    assert.ok(events.some((e) => e.type === 'preexisting'));
  });

  test('node:test の作業場でも、作業前と同じ失敗だと分かる', async () => {
    // 本物の node:test を回す。所要時間は毎回変わるので、それで別の失敗と読まないこと。
    const root = await project({
      'a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => assert.equal(1, 2));\n",
    });
    const command = `"${process.execPath}" --test a.test.mjs`;
    // 試験の中から node --test を起こすと、子は親へ報告する形（NODE_TEST_CONTEXT）になり、落ちても 0 で終わる。外して、利用者の作業場と同じ形で回す。
    const inherited = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let fixes = 0;
    let run;
    try {
      const baseline = await runVerification({ command, root }, new AbortController().signal);
      assert.equal(baseline.passed, false, `作業前の失敗が作れていない: ${baseline.output.slice(0, 300)}`);
      run = await drain(verifyLoop(
        { command, root, maxRounds: 3 },
        async () => { fixes += 1; },
        new AbortController().signal,
        undefined,
        baseline,
      ));
    } finally {
      if (inherited !== undefined) process.env.NODE_TEST_CONTEXT = inherited;
    }
    const { events, outcome } = run;
    assert.equal(outcome.preexistingFailure, true, '作業前と同じ失敗なのに、別の失敗と読んでいる');
    assert.equal(fixes, 0, '直せない失敗をモデルに投げている');
    assert.ok(events.some((e) => e.type === 'preexisting'));
  });

  test('作業前と違う失敗なら、通常どおり直させる', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'bad' });
    const baseline = await runVerification({ command: COMMAND, root }, new AbortController().signal);

    // 作業で別の壊れ方をした状態を作る
    await writeFile(join(root, 'value.txt'), 'different');

    let fixes = 0;
    const { events, outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 3 },
      async () => { fixes += 1; await writeFile(join(root, 'value.txt'), 'good'); },
      new AbortController().signal,
      undefined,
      baseline,
    ));

    assert.equal(outcome.passed, true);
    assert.equal(fixes, 1);
    assert.equal(events.some((e) => e.type === 'preexisting'), false);
  });

  test('作業前に通っていれば、失敗はこの作業のもの', async () => {
    const root = await project({ 'runner.mjs': RUNNER, 'value.txt': 'good' });
    const baseline = await runVerification({ command: COMMAND, root }, new AbortController().signal);
    assert.equal(baseline.passed, true);

    await writeFile(join(root, 'value.txt'), 'broken');
    let fixes = 0;
    const { outcome } = await drain(verifyLoop(
      { command: COMMAND, root, maxRounds: 3 },
      async () => { fixes += 1; await writeFile(join(root, 'value.txt'), 'good'); },
      new AbortController().signal,
      undefined,
      baseline,
    ));
    assert.equal(outcome.passed, true);
    assert.equal(fixes, 1);
  });
});

