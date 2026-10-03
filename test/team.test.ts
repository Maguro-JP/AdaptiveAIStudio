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
import { Team, describeHandoff, type WorkItem, type TeamProgress } from '../src/agent/team.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import type { Tool } from '../src/agent/tools/types.ts';
import { wireTeam } from '../src/core/team-setup.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

/**
 * 依頼文からファイル名を読み取り、
 * 「そのファイルを書く → 報告する」を返す偽モデル。
 * 遅延を入れて並列性を観測できるようにする。
 */
async function workerServer(delayMs: number, opts: { perModelDelay?: Record<string, number>; failModels?: string[] } = {}) {
  let peak = 0;
  let active = 0;
  /** 作業者が受け取った依頼文。申し送りが届いているかを見るため。 */
  const asked: string[] = [];
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
      if (!alreadyWrote) asked.push(instruction);
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
        // 決まりに従うモデルとして、終わりの合図まで書く。
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${target} を作成しました。\nTASK_DONE\n` } }] })}\n\n`);
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
    get asked() { return asked; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function runTeam(
  items: WorkItem[], parallel: number,
  serverOpts: { perModelDelay?: Record<string, number>; failModels?: string[] } = {},
  tools: Tool[] = [readFileTool, writeFileTool],
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
      tools,
      root,
      maxTurns: 6,
      approve: async () => true,
    });
    const progress: TeamProgress[] = [];
    const gen = team.run(items, new AbortController().signal);
    let next = await gen.next();
    while (!next.done) { progress.push(next.value); next = await gen.next(); }
    return { outcomes: next.value, progress, root, peak: server.peak, asked: server.asked };
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
  // 冗長実行は読むだけの作業に限る（書く作業は下の describe）。偽の作業者は write_file を呼ぶが、持っていないので断られて終わる
  const READ_ONLY = [readFileTool];
  test('速い方の結果が採用される', async () => {
    const { outcomes, progress } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:fast'] }],
      2,
      { perModelDelay: { m: 300, fast: 20 } },
      READ_ONLY,
    );
    assert.equal(outcomes.get('t1')?.state, 'done');

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
      READ_ONLY,
    );
    assert.equal(outcomes.get('t1')?.state, 'done', '片方の故障で全体が落ちている');
  });

  test('全部失敗すればタスクは失敗として扱われる', async () => {
    const { outcomes } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:broken'] }],
      2,
      { failModels: ['m', 'broken'] },
      READ_ONLY,
    );
    assert.equal(outcomes.get('t1')?.state, 'failed');
  });
});

describe('作業場を変えうる作業は、冗長実行しない', () => {
  /*
   * 試みはどれも同じ作業場へ書くので、勝ちが決まって残りを止めても、負けた側が書いた分は戻らない
   * （「勝者の分＋敗者の途中の分」の混ざった作業場を完了と言っていた）。一本で走らせ、そう言う。
   */
  test('書くツールを持つ作業は、一本で走らせて、そう言う', async () => {
    const { outcomes, progress, root, asked } = await runTeam(
      [{ id: 't1', laneId: 'coder', writes: ['a.txt'],
         instruction: 'a.txt を作成してください。', raceWith: ['local:fast'] }],
      2,
      { perModelDelay: { m: 30, fast: 10 } },
    );
    assert.equal(outcomes.get('t1')?.state, 'done');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'done:a.txt\n');
    assert.ok(progress.some((p) => p.type === 'raceSkipped' && p.taskId === 't1'), '一本にしたと言っていない');
    assert.ok(!progress.some((p) => p.type === 'race'), '書く作業を複数のモデルに同時に書かせている');
    assert.equal(asked.length, 1, `依頼を ${asked.length} 回送っている（一本なら 1 回）`);
  });
});

describe('申し送り', () => {
  test('先に終わった担当の報告が、次の担当に届く', async () => {
    const { asked, progress } = await runTeam(
      [item('t1', 'a.txt'), item('t2', 'b.txt', ['t1'])], 2);

    const second = asked.find((a) => a.includes('b.txt を作成してください'));
    assert.ok(second, '2人目が依頼を受けていない');
    assert.match(second, /申し送り/);
    assert.match(second, /a\.txt を作成しました/, '前の担当の報告が届いていない');
    assert.match(second, /【t1】/);

    const handed = progress.filter((p) => p.type === 'handoff');
    assert.equal(handed.length, 1, '申し送りが記録されていない');
    assert.deepEqual(handed[0]!.from, ['t1']);
  });

  test('依存が無い担当には、余計なものを渡さない', async () => {
    const { asked, progress } = await runTeam([item('t1', 'a.txt')], 1);
    assert.equal(asked[0], 'a.txt を作成してください。');
    assert.equal(progress.filter((p) => p.type === 'handoff').length, 0);
  });
});

describe('申し送り文の組み立て', () => {
  const items = new Map<string, WorkItem>([
    ['t1', { id: 't1', laneId: 'l', instruction: '設計を調べる\n（詳細は略）' }],
  ]);
  const done = (report: string) => ({
    id: 't1', state: 'done' as const, result: { report, turns: 1, finished: {} as never },
  });

  test('報告と、何の作業だったかを併せて渡す', () => {
    const text = describeHandoff([done('層は3つに分かれています。')], items);
    assert.match(text, /【t1】設計を調べる/);
    assert.match(text, /層は3つに分かれています。/);
  });

  test('確かめられていないことは、確かめられていないと書く', () => {
    const text = describeHandoff([done('調べました。')], items);
    assert.match(text, /書かれていないことは、確かめられていません/);
  });

  test('失敗も引き継ぐ。同じ壁に後続がぶつからないように', () => {
    const text = describeHandoff(
      [{ id: 't1', state: 'failed', error: 'テストが通りません' }], items);
    assert.match(text, /完了していません/);
    assert.match(text, /テストが通りません/);
  });

  test('何も言い残していない担当は、申し送りに載せない', () => {
    assert.equal(describeHandoff([done('   ')], items), '');
  });

  test('長すぎる報告は切り詰める。指示が押し出されるため', () => {
    const text = describeHandoff([done('あ'.repeat(5000))], items, 100);
    assert.ok(text.length < 400, `切り詰めていない: ${text.length}文字`);
    assert.match(text, /以下省略/);
  });

  test('依存が無ければ空。何も足さない', () => {
    assert.equal(describeHandoff([], items), '');
  });
});

/**
 * **team だけ、ハーネスも戻り先も通っていなかった。**
 *
 * 一人で使う `aas` と画面は規則の手前で止まるのに、並列で動かすこの道は
 * ツールを素で渡していた。守られたファイルも、作業場の外も、危ない命令も、
 * ここからは全部通った。書き換える前の控えも無いので、10 件走らせて壊れても
 * 戻す手が一つも無い。
 *
 * ここは**組み立てたものを Team に渡して、実際に走らせて**見る。
 * 入口（`src/cli/team.ts`）は同じ組み立て（`wireTeam`）を呼ぶだけにしてある。
 */
describe('team は素通りしない', () => {
  const run = async (file: string, protect: string[]) => {
    const server = await workerServer(10);
    const root = await tempDir('aas-team-wired-');
    process.env.AAS_STATE_DIR = await tempDir('aas-team-wired-state-');
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: server.baseUrl, locality: 'local' }));
      const wired = await wireTeam(
        { ...DEFAULT_CONFIG, harness: { ...DEFAULT_CONFIG.harness, protectedPaths: protect } },
        root);
      const team = new Team(new ChatOrchestrator(registry), {
        lanes: [{ id: 'coder', candidates: ['local:m'], parallel: 1 }],
        system: 'test',
        tools: wired.bare,
        toolsFor: (it) => wired.toolsFor(it),
        beforeWrite: (path, previous) => wired.beforeWrite(path, previous),
        root,
        maxTurns: 4,
        approve: async () => true,
      });
      const items: WorkItem[] = [{
        id: 't1', laneId: 'coder', writes: [file],
        instruction: `${file} を作成してください。`,
      }];
      const gen = team.run(items, new AbortController().signal);
      const events: TeamProgress[] = [];
      let next = await gen.next();
      while (!next.done) { events.push(next.value); next = await gen.next(); }
      return { root, events, undo: wired.undo, finish: wired.finish };
    } finally {
      await server.close();
      delete process.env.AAS_STATE_DIR;
    }
  };

  test('**守られたファイルは、team の作業者にも書けない**', async () => {
    const { root, events } = await run('secret.txt', ['secret.txt']);
    const blocked = events.some((e) =>
      e.type === 'agent' && e.event.type === 'toolEnd' && e.event.isError
      && e.event.result.includes('BLOCKED'));
    assert.ok(blocked, '規則が挟まっていません（素通りしました）');
    await assert.rejects(readFile(join(root, 'secret.txt'), 'utf8'), '書かれてしまいました');
  });

  test('守っていないファイルは、これまでどおり書ける（対）', async () => {
    const { root } = await run('a.txt', ['secret.txt']);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'done:a.txt\n');
  });

  test('**書き換えたものは、戻せる形で控えてある**', async () => {
    const { root, undo, finish } = await run('a.txt', ['secret.txt']);
    const { point } = await finish();
    assert.ok(point, '控えが残っていません（戻す手が無い）');
    assert.deepEqual(point.paths, ['a.txt']);
    await undo.restore(point.id);
    // 新しく作ったものは、戻すと消える。
    await assert.rejects(readFile(join(root, 'a.txt'), 'utf8'));
  });
});
