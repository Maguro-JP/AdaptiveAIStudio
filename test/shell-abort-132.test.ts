import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunCommandTool } from '../src/agent/tools/shell.ts';
import { tempDir } from './tmp.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('run_command を止めたら、それまでの出力も添えて返す', async () => {
  const root = await tempDir('aas-abort132-');
  const tool = createRunCommandTool({ timeoutMs: 20_000 });
  const ac = new AbortController();
  // 出力を一行出してから待つ。出たのを見てから止める
  await writeFile(join(root, 'slow.js'), "console.log('step-one-done');\nsetTimeout(() => {}, 15000);\n");
  const cmd = 'node slow.js';
  const running = tool.run({ command: cmd }, { approve: async () => true, root, signal: ac.signal } as never);
  await new Promise((r) => setTimeout(r, 1500));
  ac.abort();
  const r = await running;
  assert.equal(r.isError, true);
  assert.match(r.content, /中断されました/);
  assert.match(r.content, /step-one-done/);
});
