/**
 * ハーネスとツールの不具合（23 回目の調査）。
 *
 * - 監査の記録に、命令に含まれるトークンを残さない
 * - write_file で元の BOM を落とさない
 * - 失敗した書き込み（何も書いていない）の出し直しを、同じ内容の繰り返しとして止めない
 * - 普通のファイルでないもの・大きすぎるものを、規則とツールが丸読みしない
 * - 殻が綴りを組み替える形（`pu^sh`・`pu''sh`）・変数で組んだサブコマンド・命令を走らせる git の設定を止める
 * - 外のツールの引数が多すぎて見切れないときは断る。名前に置いた道も見る
 * - 守りを左右するファイルは協議が要る
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Harness } from '../src/harness/harness.ts';
import { AuditLog } from '../src/harness/audit.ts';
import { dangerousCommands, noRepeatedWrites, protectedPaths } from '../src/harness/builtin-rules.ts';
import { isGuarded } from '../src/harness/deliberation.ts';
import { fingerprint } from '../src/harness/seen.ts';
import { writeFileTool, readFileTool } from '../src/agent/tools/fs.ts';
import type { Tool, ToolContext } from '../src/agent/tools/types.ts';

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

const run = (command: string) => ({ name: 'run_command', args: { command } });

describe('監査の記録', () => {
  test('**通した命令の要約にも、止めた理由にも、トークンを残さない**', async () => {
    const root = await tempDir('aas-htg-audit-');
    const audit = new AuditLog();
    const shell: Tool = {
      schema: { name: 'run_command', description: 'x', parameters: { type: 'object', properties: {} } },
      run: async () => ({ content: 'ok' }),
    };
    const h = new Harness({ rules: [dangerousCommands], audit });
    const wrapped = h.wrap(shell, () => '');
    const token = `ghp_${'a'.repeat(36)}`;
    await wrapped.run({ command: `git clone https://u:${token}@github.com/o/r` }, ctx(root));
    await wrapped.run({ command: 'git push https://u:SECRETPASS@h.example/x' }, ctx(root));
    const text = JSON.stringify(audit.entries());
    assert.ok(!text.includes(token), `トークンが残った: ${text}`);
    assert.ok(!text.includes('SECRETPASS'), `トークンが残った: ${text}`);
    assert.ok(text.includes('github.com'), '宛先まで消した');
  });
});

describe('BOM', () => {
  test('**BOM 付きのファイルを全文で書き直しても、BOM を落とさない**', async () => {
    const root = await tempDir('aas-htg-bom-');
    await writeFile(join(root, 'run.cmd'), '﻿@echo off\r\nset A=1\r\n');
    const r = await writeFileTool.run({ path: 'run.cmd', content: '@echo off\nset A=2\n' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    const bytes = await readFile(join(root, 'run.cmd'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).toString('utf8'), '@echo off\r\nset A=2\r\n');
  });

  test('BOM の無いファイルには BOM を足さない（対）', async () => {
    const root = await tempDir('aas-htg-bom2-');
    await writeFile(join(root, 'a.txt'), 'x\n');
    await writeFileTool.run({ path: 'a.txt', content: 'y\n' }, ctx(root));
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'y\n');
  });
});

describe('失敗した書き込みの出し直し', () => {
  test('**何も書いていない失敗の後の、同じ引数の出し直しは止めない**（書けた後の繰り返しは今までどおり止める）', async () => {
    const root = await tempDir('aas-htg-repeat-');
    let calls = 0;
    const flaky: Tool = {
      schema: { name: 'write_file', description: 'x', parameters: { type: 'object', properties: {} } },
      run: async () => (++calls === 1 ? { content: '書き込めません（EBUSY）', isError: true } : { content: '書きました' }),
    };
    const h = new Harness({ rules: [noRepeatedWrites] });
    const w = h.wrap(flaky, () => '');
    const args = { path: 'a.txt', content: 'x' };
    assert.equal((await w.run(args, ctx(root))).isError, true);
    // 一度目は掴まれて書けなかった（やり直しを求める失敗）
    const second = await w.run(args, ctx(root));
    assert.equal(second.isError, undefined, second.content);
    const third = await w.run(args, ctx(root));
    assert.match(third.content, /no-repeated-writes/);
  });
});

describe('失敗した書き込みのうち、数え続けるもの', () => {
  test('**断られた書き込みの出し直しは、今までどおり止める**（同じ承認を何度も求めない）', async () => {
    const root = await tempDir('aas-htg-refused-');
    const refused: Tool = {
      schema: { name: 'write_file', description: 'x', parameters: { type: 'object', properties: {} } },
      run: async () => ({ content: 'ERROR: 利用者が書き込みを拒否しました', isError: true }),
    };
    const w = new Harness({ rules: [noRepeatedWrites] }).wrap(refused, () => '');
    const args = { path: 'a.txt', content: 'x' };
    await w.run(args, ctx(root));
    assert.match((await w.run(args, ctx(root))).content, /no-repeated-writes/);
  });
});

describe('監査の切れ目', () => {
  test('**長い命令の後ろにあるトークンも、切る前に伏せる**', async () => {
    const root = await tempDir('aas-htg-audit2-');
    const audit = new AuditLog();
    const shell: Tool = {
      schema: { name: 'run_command', description: 'x', parameters: { type: 'object', properties: {} } },
      run: async () => ({ content: 'ok' }),
    };
    const w = new Harness({ rules: [], audit }).wrap(shell, () => '');
    await w.run({ command: `git clone ${'-q '.repeat(40)}https://u:LONGSECRET@example.com/o/r` }, ctx(root));
    const text = JSON.stringify(audit.entries());
    assert.ok(!text.includes('LONGSECRET'), text);
    assert.ok(audit.entries()[0]!.summary!.endsWith('…'), '切ったことが分からない');
  });
});

describe('普通のファイルでないもの', () => {
  test('**指紋は、普通のファイルでないものを読まない**（`/dev/zero` へのリンクで止まらない）', { skip: process.platform === 'win32' ? 'Windows には /dev/zero が無い' : false }, async () => {
    const root = await tempDir('aas-htg-zero-');
    await symlink('/dev/zero', join(root, 'z'));
    const started = Date.now();
    assert.equal(await fingerprint(root, 'z'), undefined);
    assert.ok(Date.now() - started < 2000);
  });

  test('**read_file はフォルダや装置を読まない**', async () => {
    const root = await tempDir('aas-htg-dir-');
    await mkdir(join(root, 'sub'));
    const r = await readFileTool.run({ path: 'sub' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /普通のファイルではない/);
  });
});

describe('殻が組み替える綴り', () => {
  for (const c of ['git pu^sh', 'npm pub^lish', "git pu''sh", 'git pu\\sh', 'git pu"sh"', 'git ${x:-push}', 'git %ComSpec:~0,0%push', 'git config alias.p push', 'git config core.hooksPath .h',
    'git "p"ush', "git 'pu'sh", 'git "re"set --hard', 'git config "alias".p push', 'git -c core.pager=x log', 'git config credential.helper x', 'git config --edit']) {
    test(`**${c} を止める**`, async () => {
      assert.equal((await dangerousCommands.pre!(run(c) as never, {} as never)).kind, 'deny');
    });
  }
  for (const c of ['git status', 'git commit -m "push it"', 'git config --get alias.p', 'git config user.name x', 'npm test',
    'git config --unset alias.x', 'git config alias.x', 'git config get alias.x', 'git -c alias.s=status s', 'npm run publish-docs']) {
    test(`${c} は止めない（対）`, async () => {
      assert.equal((await dangerousCommands.pre!(run(c) as never, {} as never)).kind, 'allow');
    });
  }
});

describe('外のツールの引数', () => {
  const rule = protectedPaths(['**/.env']);
  const call = (args: unknown) => ({ name: 'mcp__fs__edit', args });
  test('**無関係な値を上限まで並べた後ろの .env も通さない**（見切れないなら断る）', async () => {
    const root = await tempDir('aas-htg-mcp-');
    const args = { edits: Array.from({ length: 2001 }, (_, i) => `x${i}`), path: '.env' };
    assert.equal((await rule.pre!(call(args) as never, { root, history: [] } as never)).kind, 'deny');
  });
  test('**道を名前に置いた形（`{"files":{".env":"…"}}`）も止める**', async () => {
    const root = await tempDir('aas-htg-mcp2-');
    assert.equal((await rule.pre!(call({ files: { '.env': 'x' } }) as never, { root, history: [] } as never)).kind, 'deny');
  });
  test('普通の引数は通す（対）', async () => {
    const root = await tempDir('aas-htg-mcp3-');
    assert.equal((await rule.pre!(call({ path: 'src/a.ts', text: 'x' }) as never, { root, history: [] } as never)).kind, 'allow');
  });
  test('**深い普通の JSON・50 ファイルの push・道でない項目名（credentials）は止めない**（対）', async () => {
    const root = await tempDir('aas-htg-mcp4-');
    const cred = protectedPaths(['**/.env', '**/credentials*']);
    let deep: unknown = { text: { content: 'こんにちは' } };
    for (let i = 0; i < 6; i++) deep = { children: [deep] };
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }));
    for (const args of [deep, { files }, { credentials: { user: 'x' } }]) {
      assert.equal((await cred.pre!(call(args) as never, { root, history: [] } as never)).kind, 'allow', JSON.stringify(args).slice(0, 80));
    }
  });
});

describe('協議の道', () => {
  test('**守りを左右するファイルは協議が要る**', () => {
    for (const p of ['src/harness/glob.ts', 'src/harness/seen.ts', 'src/agent/tools/shell.ts', 'src/agent/tools/write-kind.ts', 'src/core/redact.ts']) {
      assert.equal(isGuarded(p), true, p);
    }
    assert.equal(isGuarded('src/ui/web/app.js'), false);
    assert.equal(isGuarded('src/harness/idle.ts'), false, '守りでない所まで協議にした');
  });
});
