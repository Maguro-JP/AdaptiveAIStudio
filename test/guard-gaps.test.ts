/**
 * 守りの規則の抜け道（12 回目の調査で見つけたもの）。
 *
 * - 外へ出す前の検問が、途中に `-` の入る今の鍵（`sk-ant-api03-…` `sk-proj-…`）を通していた
 * - 「読んでから書く」が、読んだ後で替わった中身を古い中身で書き戻させていた
 * - テストの守りが、node:test の `{ skip }`・`.only`・jest の `__tests__/`・pytest の `*_test.py` を見ていなかった
 * - 協議の「広い書き換え」を、担当ごとに数えていた
 * - Windows で、末尾の点・空白や `::$DATA` の綴りから保護されたファイルを書けた
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Harness } from '../src/harness/harness.ts';
import { AuditLog } from '../src/harness/audit.ts';
import { inspectOutbound } from '../src/harness/gate.ts';
import { Forum, requiresDeliberation } from '../src/harness/deliberation.ts';
import { readBeforeWrite, testProtection, protectedPaths, isTestFile, windowsName } from '../src/harness/builtin-rules.ts';
import { readFileTool, writeFileTool, editFileTool } from '../src/agent/tools/fs.ts';
import type { Rule } from '../src/harness/rules.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import type { ToolCall } from '../src/providers/contract.ts';

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir('aas-guard-');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

function tools(rules: Rule[]) {
  const h = new Harness({ rules, audit: new AuditLog() });
  return { read: h.wrap(readFileTool, () => ''), write: h.wrap(writeFileTool, () => ''), edit: h.wrap(editFileTool, () => '') };
}

describe('外へ出す前の検問: 今の鍵の形', () => {
  // 鍵の形をした作り物（本物ではない）
  const tail = 'Ab1'.repeat(15);
  test('Anthropic の sk-ant-api03- を止める', () => {
    assert.equal(inspectOutbound(`x sk-ant-api03-${tail}`).passed, false);
  });
  test('OpenAI の sk-proj- を止める', () => {
    assert.equal(inspectOutbound(`sk-proj-${tail}`).passed, false);
  });
  test('- で終わる鍵も止める', () => {
    assert.equal(inspectOutbound(`{"note":"sk-ant-api03-${tail}-AA-"}`).passed, false);
  });
  test('ただの文の sk- は止めない（対）', () => {
    assert.equal(inspectOutbound('see the sk-learn docs').passed, true);
  });
});

describe('読んでから書く: 読んだ後の変化', () => {
  test('読んだ後で他が替えたら、全文の書き込みを止めて中身を残す', async () => {
    const root = await project({ 'a.txt': 'A\nB\n' });
    const { read, write } = tools([readBeforeWrite]);
    assert.ok(!(await read.run({ path: 'a.txt' }, ctx(root))).isError);
    await writeFile(join(root, 'a.txt'), 'A\nB\nC\n'); // 別の担当や run_command の変更
    const r = await write.run({ path: 'a.txt', content: 'A\nB2\n' }, ctx(root));
    assert.match(r.content, /^BLOCKED by read-before-write/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'A\nB\nC\n');
  });
  test('読み直せば書ける（対）', async () => {
    const root = await project({ 'a.txt': 'A\nB\n' });
    const { read, write } = tools([readBeforeWrite]);
    await read.run({ path: 'a.txt' }, ctx(root));
    await writeFile(join(root, 'a.txt'), 'A\nB\nC\n');
    await read.run({ path: 'a.txt' }, ctx(root));
    const r = await write.run({ path: 'a.txt', content: 'A\nB\nC\nD\n' }, ctx(root));
    assert.ok(!r.isError, r.content);
  });
  test('自分の edit_file の後の全文の書き込みは止めない（対）', async () => {
    const root = await project({ 'a.txt': 'A\nB\n' });
    const { read, write, edit } = tools([readBeforeWrite]);
    await read.run({ path: 'a.txt' }, ctx(root));
    assert.ok(!(await edit.run({ path: 'a.txt', find: 'B', replace: 'B2' }, ctx(root))).isError);
    const r = await write.run({ path: 'a.txt', content: 'A\nB3\n' }, ctx(root));
    assert.ok(!r.isError, r.content);
  });
});

describe('テストの守り: 数えていなかった形', () => {
  async function tryWrite(before: string, after: string, name = 'x.test.ts'): Promise<string> {
    const root = await project({ [name]: before });
    const { write } = tools([testProtection]);
    return (await write.run({ path: name, content: after }, ctx(root))).content;
  }
  test("node:test の { skip } を止める", async () => {
    assert.match(await tryWrite("test('a', () => {});\n", "test('a', { skip: 'later' }, () => {});\n"), /BLOCKED by test-protection/);
  });
  test('.only を止める', async () => {
    assert.match(await tryWrite("test('a', () => {});\ntest('b', () => {});\n", "test.only('a', () => {});\ntest('b', () => {});\n"), /BLOCKED by test-protection/);
  });
  test('Go の t.Skipf と Rust の #[ignore] を止める', async () => {
    assert.match(await tryWrite('func TestA(t *testing.T) {\n}\n', 'func TestA(t *testing.T) {\n\tt.Skipf("x")\n}\n', 'a_test.go'), /BLOCKED/);
    assert.match(await tryWrite('#[test]\nfn a() {}\n', '#[test]\n#[ignore]\nfn a() {}\n', 'tests/a.rs'), /BLOCKED/);
  });
  test('テストの中の find({ skip: 10 }) のような値は止めない（対）', async () => {
    const r = await tryWrite("test('a', async () => {\n});\n", "test('a', async () => {\n  await db.find({ skip: 10 });\n});\n");
    assert.doesNotMatch(r, /BLOCKED/);
  });
  test('jest の __tests__/ と pytest の *_test.py もテストのファイル', () => {
    assert.equal(isTestFile('src/__tests__/math.js'), true);
    assert.equal(isTestFile('pkg/foo_test.py'), true);
    assert.equal(isTestFile('src/latest.py'), false);
  });
});

describe('協議: 広い書き換えを依頼全体で数える', () => {
  const w = (path: string): ToolCall => ({ id: '', name: 'write_file', args: { path, content: '' } });
  test('他の担当の書き込みも数える', async () => {
    const root = await project();
    const rule = requiresDeliberation({ forum: new Forum(), wideChangeFiles: 2 });
    const d = await rule.pre!(w('c.ts'), { root, history: [], taskHistory: [w('a.ts'), w('b.ts')], instruction: '', signal: new AbortController().signal });
    assert.equal(d.kind, 'deny');
  });
  test('./a.ts と a.ts を二件と数えない（対）', async () => {
    const root = await project();
    const rule = requiresDeliberation({ forum: new Forum(), wideChangeFiles: 2 });
    const d = await rule.pre!(w('b.ts'), { root, history: [w('a.ts'), w('./a.ts')], instruction: '', signal: new AbortController().signal });
    assert.equal(d.kind, 'allow');
  });
});

describe('Windows の綴り: 末尾の点・空白と流れの名前', () => {
  test('Windows が作る名前に揃える', () => {
    assert.equal(windowsName('.env '), '.env');
    assert.equal(windowsName('keys/id.pem.'), 'keys/id.pem');
    assert.equal(windowsName('.env::$DATA'), '.env');
    assert.equal(windowsName('C:/x/../a.'), 'C:/x/../a');
  });
  for (const path of ['.env ', '.env::$DATA', 'id.pem.']) {
    test(`無いファイルとして ${JSON.stringify(path)} を書くのを止める`, async () => {
      const root = await project();
      const { write } = tools([protectedPaths(['**/.env', '**/*.pem'], { nocase: true, windows: true })]);
      assert.match((await write.run({ path, content: 'x' }, ctx(root))).content, /BLOCKED by protected-paths/);
    });
  }
});
