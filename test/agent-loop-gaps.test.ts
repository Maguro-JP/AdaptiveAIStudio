/**
 * 76 回目の不具合調査（作業ループ・git・協議・find_code）の分。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type { ChatOrchestrator, ChatEvent } from '../src/core/orchestrator.ts';
import type { ProviderMessage as Message } from '../src/providers/contract.ts';
import type { Tool } from '../src/agent/tools/types.ts';
import { inspectGit } from '../src/agent/git.ts';
import { Forum, requiresDeliberation } from '../src/harness/deliberation.ts';

/** 回ごとに決めた出来事を流す、偽の orchestrator。 */
function scripted(turns: ChatEvent[][]): ChatOrchestrator {
  let n = 0;
  return {
    async *run() {
      const evs = turns[Math.min(n, turns.length - 1)]!;
      n += 1;
      for (const ev of evs) yield ev;
    },
  } as unknown as ChatOrchestrator;
}

const noop: Tool = {
  schema: { name: 'noop', description: 'x', parameters: { type: 'object', properties: {} } } as never,
  run: async () => ({ content: 'ok' }),
};

async function agentWith(turns: ChatEvent[][]): Promise<Agent> {
  return new Agent(scripted(turns), {
    candidates: ['m'], system: 'test', tools: [noop], root: await tempDir('aas-loop-gaps-'), maxTurns: 4, approve: async () => true,
  });
}

const call = (id: string): ChatEvent => ({ type: 'toolCall', call: { id, name: 'noop', args: {} } });
const done: ChatEvent = { type: 'done', modelId: 'm' };

describe('作業ループ', () => {
  test('**受け手が toolStart で抜けても、結果の無い呼び出しを残さない**', async () => {
    const agent = await agentWith([[call('c1'), done]]);
    const history: Message[] = [{ role: 'user', content: 'やって' }];
    for await (const ev of agent.run(history, new AbortController().signal)) {
      if (ev.type === 'toolStart') break;
    }
    const last = history.at(-1) as { role: string; toolCallId?: string };
    assert.equal(last.role, 'tool', `結果の無い呼び出しが残っている: ${JSON.stringify(history.at(-1))}`);
    assert.equal(last.toolCallId, 'c1');
  });

  test('受け手が toolEnd で抜けても、走ったツールの結果は残す', async () => {
    const agent = await agentWith([[call('c1'), done]]);
    const history: Message[] = [{ role: 'user', content: 'やって' }];
    for await (const ev of agent.run(history, new AbortController().signal)) {
      if (ev.type === 'toolEnd') break;
    }
    const tools = history.filter((m) => m.role === 'tool') as Array<{ content: string }>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.content, 'ok');
  });

  test('**終わりの合図をツールと一緒に出し、次の返事が空なら完了**', async () => {
    const agent = await agentWith([
      [{ type: 'text', delta: '直しました。\nTASK_DONE\n' }, call('c1'), done],
      [done],
    ]);
    const events: AgentEvent[] = [];
    for await (const ev of agent.run([{ role: 'user', content: 'やって' }], new AbortController().signal)) events.push(ev);
    const end = events.at(-1);
    assert.equal(end?.type, 'finished');
    if (end?.type === 'finished') assert.equal(end.reason, 'completed', end.detail);
  });

  test('合図が無いまま空なら、これまでどおり「動かなかった」（対）', async () => {
    const agent = await agentWith([[call('c1'), done], [done]]);
    const events: AgentEvent[] = [];
    for await (const ev of agent.run([{ role: 'user', content: 'やって' }], new AbortController().signal)) events.push(ev);
    const end = events.at(-1);
    if (end?.type === 'finished') assert.notEqual(end.reason, 'completed');
  });
});

const GIT_OK = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

describe('git の状態', { skip: GIT_OK ? false : 'この機械には git が無い' }, () => {
  test('**未追跡を隠す設定（showUntrackedFiles=no）でも、未追跡のファイルを挙げる**', async () => {
    const root = await tempDir('aas-git-gaps-');
    git(root, 'init', '-q');
    await writeFile(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first');
    git(root, 'config', 'status.showUntrackedFiles', 'no');
    await writeFile(join(root, 'new.txt'), 'n\n');
    const s = await inspectGit(root);
    assert.equal(s.kind, 'dirty', JSON.stringify(s));
  });

  test('**作業場ごと親の .gitignore で外されていたら、クリーンと言わない**', async () => {
    const root = await tempDir('aas-git-gaps-');
    git(root, 'init', '-q');
    await writeFile(join(root, '.gitignore'), 'scratch/\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first');
    await mkdir(join(root, 'scratch', 'proj'), { recursive: true });
    await writeFile(join(root, 'scratch', 'proj', 'a.txt'), 'a\n');
    const s = await inspectGit(join(root, 'scratch', 'proj'));
    assert.notEqual(s.kind, 'clean', JSON.stringify(s));
  });

  test('中の外されたもの（node_modules など）は数えない（対）', async () => {
    const root = await tempDir('aas-git-gaps-');
    git(root, 'init', '-q');
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first');
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x', 'i.js'), '\n');
    const s = await inspectGit(root);
    assert.equal(s.kind, 'clean', JSON.stringify(s));
  });
});

describe('協議', () => {
  test('**協議を通した道と、書く道の綴りが違っても（絶対の道）、同じ実体なら通す**', async () => {
    const root = await tempDir('aas-delib-gaps-');
    await mkdir(join(root, 'src', 'harness'), { recursive: true });
    await writeFile(join(root, 'src', 'harness', 'gate.ts'), '\n');
    const forum = new Forum();
    forum.add({ subject: 's', reason: 'r', impact: 'i', rollback: 'b', paths: ['src/harness/gate.ts'], at: Date.now() });
    const rule = requiresDeliberation({ forum });
    const d = await rule.pre!(
      { id: 'w', name: 'write_file', args: { path: join(root, 'src', 'harness', 'gate.ts'), content: 'x' } },
      { root, history: [], instruction: '', signal: new AbortController().signal },
    );
    assert.equal(d.kind, 'allow', JSON.stringify(d));
  });
});

describe('find_code', () => {
  test('**件数（limit）を文字列で渡されても効かせる**', async () => {
    const root = await tempDir('aas-find-gaps-');
    process.env.AAS_STATE_DIR = await tempDir('aas-find-state-');
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, `${n}.ts`), `// read the settings file\nexport function loadSettings${n}() { return 'settings'; }\n`);
    // 全部のファイルに出る言葉は点が付かないので、出ないファイルも置く
    for (const n of ['d', 'e', 'f']) await writeFile(join(root, `${n}.ts`), `export const other${n} = 2;\n`);
    const { findCodeTool } = await import('../src/agent/tools/find.ts');
    const got = await findCodeTool.run({ query: 'settings', limit: '1' },
      { root, signal: new AbortController().signal, approve: () => Promise.resolve(true) } as never);
    const named = ['a.ts', 'b.ts', 'c.ts'].filter((f) => got.content.includes(f));
    assert.equal(named.length, 1, got.content);
  });
});
