/**
 * 既定で守るファイルは、作業場の下のどの階層に在っても守る。
 *
 * 既定の守り（`src/core/harness-setup.ts` の `DEFAULT_PROTECTED`）のうち、`.env`・`.env.*`・`package-lock.json`・`pnpm-lock.yaml` は
 * 作業場の直下だけに当たっていた（道は全体で照らすので、`**\/` が無い名前は直下のものだけ）。monorepo の `packages/api/.env` は
 * 守りの外で、書き込みの承認が自動の既定では、誰にも訊かずに書き換えていた。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-protected-nested-state-');
const { buildHarness } = await import('../src/core/harness-setup.ts');
const { writeFileTool } = await import('../src/agent/tools/fs.ts');

let root = '';
before(async () => {
  root = await tempDir('aas-protected-nested-');
  for (const at of ['packages/api/.env', 'apps/web/.env.local', 'packages/api/package-lock.json', 'apps/web/pnpm-lock.yaml', '.env']) {
    await mkdir(join(root, at, '..'), { recursive: true });
    await writeFile(join(root, at), 'ORIGINAL');
  }
});

describe('既定で守るファイルは、どの階層でも守る', () => {
  for (const at of ['packages/api/.env', 'apps/web/.env.local', 'packages/api/package-lock.json', 'apps/web/pnpm-lock.yaml', '.env']) {
    test(`${at} には書かない`, async () => {
      // 読んでから書く規則は外す（そちらでも止まるので、守る道の規則だけを見る）
      const harness = await buildHarness({ agent: { root }, harness: { readBeforeWrite: false } } as never, undefined, undefined, 'linux');
      const tool = harness.wrap(writeFileTool, () => '');
      const r = await tool.run({ path: at, content: 'CHANGED' }, {
        root, signal: new AbortController().signal, approve: async () => true,
      });
      assert.equal(r.isError, true, `守りの外で書けた: ${r.content}`);
      assert.match(r.content, /protected-paths/);
      assert.equal(await readFile(join(root, at), 'utf8'), 'ORIGINAL');
    });
  }
});
