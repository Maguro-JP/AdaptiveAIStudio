/**
 * 外のツール（MCP）のうち命令を走らせるものにも、run_command と同じ止め方を当てる。
 *
 * 危ない命令・自分を殺す止め方・断りのない CI の三つの規則は、run_command にしか当てていなかったので、
 * Desktop Commander の `start_process` のような口に `{"command":"git push --force"}` を渡すと素通りした。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dangerousCommands, noSelfKill, noCiSpend } from '../src/harness/builtin-rules.ts';
import { EXTERNAL_SEPARATOR } from '../src/agent/tools/write-kind.ts';

const ctx = { root: process.cwd(), history: [], instruction: '', signal: new AbortController().signal };
const ext = (args: unknown) => ({ id: 'x', name: `desktop${EXTERNAL_SEPARATOR}start_process`, args });

describe('外のツールの命令', () => {
  test('**危ない命令を止める**', async () => {
    for (const command of ['git push --force', 'rm -rf build', 'git -C . reset --hard']) {
      const d = await dangerousCommands.pre!(ext({ command }) as never, ctx as never);
      assert.equal(d.kind, 'deny', `通した: ${command}`);
    }
    // 語の並びで渡す形も
    const d = await dangerousCommands.pre!(ext({ command: ['git', 'push'] }) as never, ctx as never);
    assert.equal(d.kind, 'deny');
  });

  test('**自分を殺す止め方と、断りのない CI を止める**', async () => {
    assert.equal((await noSelfKill.pre!(ext({ cmd: 'pkill -f node' }) as never, ctx as never)).kind, 'deny');
    assert.equal((await noCiSpend.pre!(ext({ script: 'gh workflow run ci.yml' }) as never, ctx as never)).kind, 'deny');
  });

  test('命令の話を本文に書いただけの呼び出しは止めない（対）', async () => {
    const d = await dangerousCommands.pre!(ext({ body: 'git push --force は使わないでください' }) as never, ctx as never);
    assert.equal(d.kind, 'allow');
    assert.equal((await noSelfKill.pre!(ext({ title: 'pkill -f node の話' }) as never, ctx as never)).kind, 'allow');
  });

  test('run_command は、これまでどおり（対）', async () => {
    const d = await dangerousCommands.pre!({ id: 'y', name: 'run_command', args: { command: 'git push' } } as never, ctx as never);
    assert.equal(d.kind, 'deny');
  });
});
