/** 複数の作業者が実際に並列でファイルを編集できるかの検証。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Team, type WorkItem, type TeamProgress } from '../src/agent/team.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';

/**
 * 依頼文からファイル名を読み取り、
 * 「そのファイルを書く → 報告する」を返す偽モデル。
 * 遅延を入れて並列性を観測できるようにする。
 */
async function workerServer(delayMs: number, opts: { perModelDelay?: Record<string, number>; failModels?: string[] } = {}) {
  let peak = 0;
  let active = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (ch) => { body += ch; });
    req.on('end', async () => {
      active += 1; peak = Math.max(peak, active);
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const alreadyWrote = parsed.messages.some((m) => m.role === 'tool');
      // 依頼文は user メッセージ。system を拾わないよう role で絞る。
      const instruction = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const target = /([a-z0-9_]+\.txt)/.exec(instruction)?.[1] ?? 'x.txt';

      const model = (JSON.parse(body) as { model?: string }).model ?? '';
      const wait = opts.perModelDelay?.[model] ?? delayMs;
      await new Promise((r) => setTimeout(r, wait));

      if (opts.failModels?.includes(model)) {
        active -= 1;
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('model broken');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (alreadyWrote) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${target} を作成しました。` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      } else {
        const args = JSON.stringify({ path: target, content: `done:${target}\n` });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      active -= 1;
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get peak() { return peak; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function runTeam(
  items: WorkItem[], parallel: number,
  serverOpts: { perModelDelay?: Record<string, number>; failModels?: string[] } = {},
) {
  const server = await workerServer(60, serverOpts);
  const root = await tempDir('aas-team-');
  await writeFile(join(root, 'seed.txt'), 'seed\n');
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: server.baseUrl, locality: 'local' }));
    const team = new Team(new ChatOrchestrator(registry), {
      lanes: [{ id: 'coder', candidates: ['local:m'], parallel }],
      system: 'test',
      tools: [readFileTool, writeFileTool],
      root,
      maxTurns: 6,
      approve: async () => true,
    });
    const progress: TeamProgress[] = [];
    const gen = team.run(items, new AbortController().signal);
    let next = await gen.next();
    while (!next.done) { progress.push(next.value); next = await gen.next(); }
    return { outcomes: next.value, progress, root, peak: server.peak };
  } finally {
    await server.close();
  }
}

const item = (id: string, file: string, deps?: string[]): WorkItem => ({
  id, laneId: 'coder', deps, writes: [file],
  instruction: `${file} を作成してください。`,
});

describe('チーム並列実行', () => {
  test('3名が同時に別ファイルを作成する', async () => {
    const { outcomes, root, peak } = await runTeam(
      [item('t1', 'a.txt'), item('t2', 'b.txt'), item('t3', 'c.txt')], 3);

    assert.equal([...outcomes.values()].filter((o) => o.state === 'done').length, 3);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'done:a.txt\n');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'done:b.txt\n');
    assert.equal(await readFile(join(root, 'c.txt'), 'utf8'), 'done:c.txt\n');
    assert.ok(peak >= 2, `並列に走っていない (peak=${peak})`);
  });

  test('レーンの並列上限を超えて同時実行しない', async () => {
    const { peak } = await runTeam(
      [item('t1', 'a.txt'), item('t2', 'b.txt'), item('t3', 'c.txt'), item('t4', 'd.txt')], 2);
    assert.ok(peak <= 2, `上限を超えた (peak=${peak})`);
  });

  test('依存のあるタスクは前段の完了後に走る', async () => {
    const { progress } = await runTeam(
      [item('after', 'z.txt', ['before']), item('before', 'y.txt')], 3);
    const starts = progress.filter((p) => p.type === 'taskStart').map((p) => p.taskId);
    const ends = progress.filter((p) => p.type === 'taskEnd').map((p) => p.taskId);
    assert.equal(starts.indexOf('after') > starts.indexOf('before'), true);
    assert.equal(ends.indexOf('before') < starts.length, true);
  });

  test('各作業者の進捗が taskId つきで届く', async () => {
    const { progress } = await runTeam([item('t1', 'a.txt'), item('t2', 'b.txt')], 2);
    const toolEvents = progress.filter(
      (p): p is Extract<TeamProgress, { type: 'agent' }> =>
        p.type === 'agent' && p.event.type === 'toolStart');
    assert.ok(toolEvents.some((p) => p.taskId === 't1'));
    assert.ok(toolEvents.some((p) => p.taskId === 't2'));
  });
});

describe('冗長実行（同じ作業を複数モデルへ同時に投げる）', () => {
  test('速い方の結果が採用される', async () => {
    const { outcomes, progress, root } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:fast'] }],
      2,
      { perModelDelay: { m: 300, fast: 20 } },
    );
    assert.equal(outcomes.get('t1')?.state, 'done');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'done:a.txt\n');

    const winner = progress.find(
      (p): p is Extract<TeamProgress, { type: 'race' }> =>
        p.type === 'race' && p.event.type === 'winner');
    assert.equal(winner?.event.type === 'winner' && winner.event.label, 'local:fast');
  });

  test('速い方が壊れていても、遅い方が拾って完了する', async () => {
    const { outcomes } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:broken'] }],
      2,
      { perModelDelay: { m: 40, broken: 5 }, failModels: ['broken'] },
    );
    assert.equal(outcomes.get('t1')?.state, 'done', '片方の故障で全体が落ちている');
  });

  test('全部失敗すればタスクは失敗として扱われる', async () => {
    const { outcomes } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:broken'] }],
      2,
      { failModels: ['m', 'broken'] },
    );
    assert.equal(outcomes.get('t1')?.state, 'failed');
  });
});
