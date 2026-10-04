/**
 * 作業後の確かめの不具合（26 回目の調査）。
 *
 * - 作業前と同じ失敗は、何回目でも「作業前から」と見る（1 回目だけ見ていた）
 * - 失敗の要約から、毎回変わる時刻（vitest・pytest）と go の `(cached)` を落とす
 * - テストの数え方: コメントにしたテスト・`.test(`・async def・`#[tokio::test]`・中から skip
 * - 作業前後の比べ: `.only` を足したら通さない。テストの無いファイルは消えても問わない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tempDir } from './tmp.ts';
import { digestFailure, verifyLoop, runVerification, type VerifyEvent } from '../src/agent/verify.ts';
import { countCases, countSkips } from '../src/agent/test-patterns.ts';
import { snapshotTests, compareTests } from '../src/agent/test-integrity.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-verify-gaps-');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

describe('作業前からの失敗', () => {
  test('**新しい失敗を直して作業前と同じ失敗だけになった回も、作業前からと見る**（2 回目でも）', async () => {
    // 落ちる中身を value.txt で決める。X は作業前からある失敗、Y はこの回で足した失敗
    const runner = `
import { readFileSync } from 'node:fs';
const v = readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim().split(',');
for (const name of v) console.error('FAIL ' + name);
process.exit(v.length > 0 && v[0] !== '' ? 1 : 0);
`;
    const root = await project({ 'runner.mjs': runner, 'value.txt': 'X' });
    const command = `"${process.execPath}" runner.mjs`;
    const baseline = await runVerification({ command, root }, new AbortController().signal);
    assert.equal(baseline.passed, false);
    await writeFile(join(root, 'value.txt'), 'X,Y'); // 作業で Y を足した
    const events: VerifyEvent[] = [];
    const gen = verifyLoop(
      { command, root, maxRounds: 4 },
      async () => { await writeFile(join(root, 'value.txt'), 'X'); }, // Y を直した
      new AbortController().signal, undefined, baseline,
    );
    let step = await gen.next();
    while (!step.done) { events.push(step.value); step = await gen.next(); }
    assert.equal(step.value.preexistingFailure, true, `作業前からと見ていない: ${events.map((e) => e.type).join(',')}`);
  });
});

describe('失敗の要約', () => {
  test('**vitest の開始時刻・pytest の経過時間・go の (cached) が違うだけなら、同じ失敗**', () => {
    assert.equal(
      digestFailure(' FAIL  a.test.ts > x\n Test Files  1 failed (1)\n   Start at  10:21:33\n   Duration  1.20s'),
      digestFailure(' FAIL  a.test.ts > x\n Test Files  1 failed (1)\n   Start at  10:24:05\n   Duration  1.31s'),
    );
    assert.equal(digestFailure('1 failed in 62.34s (0:01:02)'), digestFailure('1 failed in 65.10s (0:01:05)'));
    assert.equal(digestFailure('ok  \tpkg/a\t0.01s\n--- FAIL: TestB'), digestFailure('ok  \tpkg/a\t(cached)\n--- FAIL: TestB'));
  });
  test('失敗の中身が違えば、別の失敗（対）', () => {
    assert.notEqual(digestFailure('--- FAIL: TestA'), digestFailure('--- FAIL: TestB'));
  });
});

describe('テストの数え方', () => {
  test('**コメントにしたテストは数えない**', () => {
    assert.equal(countCases("// test('a', () => {})"), 0);
    assert.equal(countCases("/* it('b', () => {}) */"), 0);
    assert.equal(countCases("test('a', () => {}) // 後ろのコメント"), 1);
    assert.equal(countCases('const u = "http://x"; test("b", f)'), 1, 'URL の // で落とした');
  });
  test('**`/x/.test(s)` の `.test(` は数えない**', () => {
    assert.equal(countCases('expect(/a/.test(s)).toBe(true)'), 0);
  });
  test('**Python の async def と Rust の #[tokio::test] も数える**', () => {
    assert.equal(countCases('async def test_a():\n    pass'), 1);
    assert.equal(countCases('#[tokio::test]\nasync fn a() {}'), 1);
  });
  test('**中から skip する形（pytest.skip・self.skipTest）も skip と数える**', () => {
    assert.equal(countSkips('def test_a():\n    pytest.skip("x")'), 1);
    assert.equal(countSkips('def test_a(self):\n    self.skipTest("x")'), 1);
  });
});

describe('作業前後の比べ', () => {
  test('**.only を足したら通さない**（数は変わらない）', async () => {
    const root = await project({ 'a.test.ts': "test('a', () => {});\ntest('b', () => {});\n" });
    const before = await snapshotTests(root);
    await writeFile(join(root, 'a.test.ts'), "test.only('a', () => {});\ntest('b', () => {});\n");
    assert.equal(compareTests(before, await snapshotTests(root)).ok, false);
  });
  test('**テストが一つも無かったファイル（置き物）は、消えても問わない**', async () => {
    const root = await project({ 'test/fixtures/a.json': '{}', 'test/a.test.ts': "test('a', () => {});" });
    const before = await snapshotTests(root);
    await rm(join(root, 'test/fixtures/a.json'));
    assert.equal(compareTests(before, await snapshotTests(root)).ok, true);
  });
  test('テストの在るファイルを消したら、今までどおり通さない（対）', async () => {
    const root = await project({ 'test/a.test.ts': "test('a', () => {});" });
    const before = await snapshotTests(root);
    await rm(join(root, 'test/a.test.ts'));
    assert.equal(compareTests(before, await snapshotTests(root)).ok, false);
  });
});

describe('レビューで挙がった筋書き', () => {
  test('**文字列の中の `/*` から後ろを、コメントと見て消さない**', () => {
    assert.equal(countCases("app.get('/api/*', h);\ntest('a', f);\n/** x */\n"), 1);
    assert.equal(countCases("const g = glob('**/*.test.ts');\nit('b', f);\n// */\n"), 1);
    assert.equal(countCases('const r = /https?:\\/\\//;\ntest("c", f);\n'), 1, '正規表現の \\/\\/ を // と読んだ');
  });
  test('**`Deno.test(`・`t.test(`・`QUnit.test(` は数える**（`/x/.test(` は今までどおり数えない）', () => {
    assert.equal(countCases("Deno.test('a', () => {});\nawait t.test('b', () => {});\nQUnit.test('c', a => {});"), 3);
    assert.equal(countCases('if (/a/.test(s)) {}'), 0);
  });
  test('**引数を取る Rust のテスト属性を、一つと数える**（JS の数え方が `::test(` を拾って二重に数えない）', () => {
    assert.equal(countCases('#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}'), 1);
    assert.equal(countCases('#[test_case(1)]\nfn a() {}'), 0, 'test_case まで数えた');
  });
  test('**数え方を持たない言語のテストファイル（tests/FooTest.java）を消したら通さない**', async () => {
    const root = await project({ 'tests/FooTest.java': 'class FooTest { @Test void a() {} }', 'test/a.test.ts': "test('a', () => {});" });
    const before = await snapshotTests(root);
    await rm(join(root, 'tests/FooTest.java'));
    assert.equal(compareTests(before, await snapshotTests(root)).ok, false);
  });
  test('**作業前と同じ失敗に戻っても、テストを消して戻したのなら作業前からと言わない**', async () => {
    // X は作業前から落ちるテスト。作業で Y を足して落とし、直す回で Y のテストファイルごと消す
    const runner = `
import { existsSync } from 'node:fs';
console.error('FAIL X');
if (existsSync(new URL('./test/y.test.ts', import.meta.url))) console.error('FAIL Y');
process.exit(1);
`;
    const root = await project({ 'runner.mjs': runner, 'test/x.test.ts': "test('x', () => {});" });
    const command = `"${process.execPath}" runner.mjs`;
    const baseline = await runVerification({ command, root }, new AbortController().signal);
    await writeFile(join(root, 'test/y.test.ts'), "test('y', () => {});");
    const events: VerifyEvent[] = [];
    // 作業前の数はこの回の始めに取られるので、y.test.ts がある状態から始まる
    const gen = verifyLoop(
      { command, root, maxRounds: 3 },
      async () => { await rm(join(root, 'test/y.test.ts'), { force: true }); },
      new AbortController().signal, undefined, baseline,
    );
    let step = await gen.next();
    while (!step.done) { events.push(step.value); step = await gen.next(); }
    assert.notEqual(step.value.preexistingFailure, true, `消して戻したのに作業前から: ${events.map((e) => e.type).join(',')}`);
    assert.ok(events.some((e) => e.type === 'tampered'), `消したことを言っていない: ${events.map((e) => e.type).join(',')}`);
  });
  test('**値に時刻が入った失敗は、時刻が違えば別の失敗**（均すのは開始時刻と経過時間だけ）', () => {
    assert.notEqual(digestFailure("expected '10:00:00' received '11:00:00'"), digestFailure("expected '10:00:00' received '12:00:00'"));
  });
});
