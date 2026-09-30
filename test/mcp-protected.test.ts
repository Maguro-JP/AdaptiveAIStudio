/**
 * 外から来たツール（MCP）も、保護されたファイルに触らせない。
 *
 * 守りは `isWriteTool` で入口を絞っていた。名前の一致で見るので、
 * `write_file` と `edit_file` の二つだけが通る。MCP のツールは
 * `<サーバ名>__<ツール名>` なので、**一つも当たらない。**
 * 保護されたファイルも、読んでから書く規則も、戻り先も、全部その外に居た。
 *
 * 何をするか分からないものを「書かない側」に置くと、守りが素通りする。
 * **分からないものは、書くかもしれない側に置く。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Harness } from '../src/harness/harness.ts';
import { AuditLog } from '../src/harness/audit.ts';
import { protectedPaths } from '../src/harness/builtin-rules.ts';
import {
  EXTERNAL_SEPARATOR, isExternalTool, mayWriteFiles,
} from '../src/agent/tools/write-kind.ts';
import { readFileTool } from '../src/agent/tools/fs.ts';
import { ok, type Tool, type ToolContext } from '../src/agent/tools/types.ts';

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir('aas-mcp-protected-');
  for (const [name, content] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

/** 外から来たツールの代わり。**呼ばれたことが分かる形**にしておく。 */
function externalTool(called: { count: number }): Tool {
  return {
    schema: {
      name: `notes${EXTERNAL_SEPARATOR}save`,
      description: '[notes] 何をするかは、こちらからは分からない',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
    async run() {
      called.count += 1;
      return ok('done');
    },
  };
}

function harness(patterns: string[]) {
  return new Harness({ rules: [protectedPaths(patterns)], audit: new AuditLog() });
}

describe('外から来たツールと、保護されたファイル', () => {
  test('**保護されたファイルを名指ししたら止める**', async () => {
    const root = await project({ '.env': 'SECRET=1' });
    const called = { count: 0 };
    const tool = harness(['.env']).wrap(externalTool(called), () => '');

    const r = await tool.run({ path: '.env' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /BLOCKED by protected-paths/);
    // **止めたなら、相手を呼んでいない。**呼んでから止めても、もう遅い。
    assert.equal(called.count, 0, '外のツールが呼ばれてしまった');
  });

  test('**引数の名前が path でなくても止める**', async () => {
    /*
     * 外のツールの引数の名前は、相手が決める。`path` だとは限らない
     * （`file` `filename` `target` …）。`argString(call, 'path')` だけを
     * 見ていると、名前を変えるだけで素通りする。
     */
    const root = await project({ '.env': 'SECRET=1' });
    const called = { count: 0 };
    const tool = harness(['.env']).wrap(externalTool(called), () => '');

    const r = await tool.run({ filename: '.env', mode: 'append' }, ctx(root));
    assert.equal(r.isError, true, `止まっていない: ${r.content}`);
    assert.equal(called.count, 0);
  });

  test('**入れ子の引数でも止める**', async () => {
    const root = await project({ '.env': 'SECRET=1' });
    const called = { count: 0 };
    const tool = harness(['.env']).wrap(externalTool(called), () => '');

    const r = await tool.run({ files: [{ at: 'src/a.ts' }, { at: '.env' }] }, ctx(root));
    assert.equal(r.isError, true, `止まっていない: ${r.content}`);
    assert.equal(called.count, 0);
  });

  test('保護対象でなければ通す（対）', async () => {
    const root = await project({ '.env': 'SECRET=1', 'src/a.ts': 'x' });
    const called = { count: 0 };
    const tool = harness(['.env']).wrap(externalTool(called), () => '');

    const r = await tool.run({ path: 'src/a.ts', note: '直してください' }, ctx(root));
    assert.notEqual(r.isError, true, `止まってしまった: ${r.content}`);
    assert.equal(called.count, 1);
  });

  test('普通の文に .env と書いてあるだけでは止めない（対）', async () => {
    // 丸ごと一致で見るので、文の中に混ざっているだけでは当たらない。
    // ここが当たると、外のツールへ何も渡せなくなる。
    const root = await project({ '.env': 'SECRET=1' });
    const called = { count: 0 };
    const tool = harness(['.env']).wrap(externalTool(called), () => '');

    const r = await tool.run({ text: '.env の書き方を教えてください' }, ctx(root));
    assert.notEqual(r.isError, true, `止まってしまった: ${r.content}`);
    assert.equal(called.count, 1);
  });

  test('どの階層でも守る形（**/.env）でも、道で終わる文は止めない。空白を含む本当の道は止める', async () => {
    // 既定の守りは **/ でどの階層にも当たる。文の最初の区切り（「please check packages」）まで道として見ると、
    // issue やコメントに .env の話を書けなくなる
    const root = await project({ 'packages/api/.env': 'SECRET=1', 'My Docs/.env': 'SECRET=2' });
    const called = { count: 0 };
    const tool = harness(['**/.env']).wrap(externalTool(called), () => '');

    const talk = await tool.run({ body: 'please check packages/api/.env' }, ctx(root));
    assert.notEqual(talk.isError, true, `文で止まった: ${talk.content}`);
    const nested = await tool.run({ path: 'packages/api/.env' }, ctx(root));
    assert.equal(nested.isError, true, '下の階層の .env を外のツールへ渡した');
    const spaced = await tool.run({ path: 'My Docs/.env' }, ctx(root));
    assert.equal(spaced.isError, true, '空白を含む道の .env を外のツールへ渡した');
    assert.equal(called.count, 1);
  });

  test('この場所の読むツールは、いままで通り読める（対）', async () => {
    /*
     * 保護は「書き換えさせない」ためのもの。読む側まで止めると、
     * `.env` を見て設定を直す、が丸ごとできなくなる。
     * **外のツールだけを、書くかもしれない側へ動かす。**
     */
    const root = await project({ '.env': 'SECRET=1' });
    const read = harness(['.env']).wrap(readFileTool, () => '');
    const r = await read.run({ path: '.env' }, ctx(root));
    assert.notEqual(r.isError, true, `読めなくなっている: ${r.content}`);
  });
});

describe('外から来たツールの見分け方', () => {
  test('名前に区切りが入っていれば外から来たもの', () => {
    assert.equal(isExternalTool(`notes${EXTERNAL_SEPARATOR}save`), true);
    assert.equal(isExternalTool('write_file'), false);
    assert.equal(isExternalTool('read_file'), false);
  });

  test('分からないものは「書くかもしれない」側', () => {
    assert.equal(mayWriteFiles('write_file'), true);
    assert.equal(mayWriteFiles('edit_file'), true);
    assert.equal(mayWriteFiles(`notes${EXTERNAL_SEPARATOR}save`), true);
    assert.equal(mayWriteFiles('read_file'), false);
    assert.equal(mayWriteFiles('list_files'), false);
  });

  test('**この場所のツールの名前に、区切りを入れない**', async () => {
    /*
     * 見分け方が名前なので、この場所のツールが `__` を持った瞬間に
     * 「外から来たもの」として扱われる。**足した人は気づかない**
     * （名前を決めるときに、この規則のことは考えない）。ここで止める。
     */
    const dir = join(import.meta.dirname, '..', 'src', 'agent', 'tools');
    const names: string[] = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts')) continue;
      const src = await readFile(join(dir, file), 'utf8');
      for (const m of src.matchAll(/\bname: '([^']+)'/g)) names.push(m[1]!);
    }
    assert.ok(names.length >= 10, `ツールの名前が拾えていない: ${names.length} 件`);
    const bad = names.filter((n) => n.includes(EXTERNAL_SEPARATOR));
    assert.deepEqual(bad, [], `外から来たものとして扱われます: ${bad.join(', ')}`);
  });
});
