/**
 * `aas agent` の入口と CLI の小物の不具合（39 回目の調査）。
 *
 * - Ctrl-C で、動いている依頼を本当に止める（止める手が、依頼の中まで届く）
 * - `/exit` の後、考えごとの待ち時間（既定 30 秒）まで終わらずに残らない
 * - 知らない `/` の命令や打ち間違いを、書けるツール付きの依頼としてモデルへ送らない
 * - 同じ分のうちに二度書いた報告を、上書きしない
 * - 改行が CRLF のテストの出力でも、通ったと読む（これは前から読めていた。固定しておく）
 * - 閉じるときに、待たずに走らせた判じ手も止める（`/exit` の後に残らない）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import { cleanAasEnv } from './env.ts';
import { testsPassed } from '../src/cli/tests-verdict.ts';
import { saveReport } from '../src/cli/report-file.ts';

let fake: FakeServer;
before(async () => { fake = await startFakeServer({ kind: 'hang' }); });
after(async () => { await fake.close(); });

/** `aas agent` を子として起こす。入力は手で流し込む。 */
async function startAgent(): Promise<{ write: (s: string) => void; output: () => string; exited: Promise<number | null>; kill: (sig: NodeJS.Signals) => void }> {
  const dir = await tempDir('aas-agent-cli-');
  const root = join(dir, 'work');
  await mkdir(root, { recursive: true });
  const config = join(dir, 'aas.config.json');
  await writeFile(config, JSON.stringify({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', maxTurns: 2 },
  }));
  const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
  const child = spawn(process.execPath, [...flags, '--no-warnings', join(installRoot(), 'src', 'cli', 'agent.ts')], {
    env: cleanAasEnv({ AAS_CONFIG: config, AAS_HOME: join(dir, 'home'), AAS_STATE_DIR: join(dir, 'state'), NO_COLOR: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return {
    write: (s) => { child.stdin.write(s); },
    output: () => out,
    exited,
    kill: (sig) => { child.kill(sig); },
  };
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); })]);
  } finally { clearTimeout(t); }
}

describe('aas agent の入口', { timeout: 120_000, skip: process.platform === 'win32' ? '子へ SIGINT を送れない' : false }, () => {
  test('**Ctrl-C で動いている依頼を止め、その後の /exit ですぐ終わる**', async () => {
    const agent = await startAgent();
    try {
      await until(() => /\/exit で終了/.test(agent.output()), `起動しない:\n${agent.output().slice(-600)}`);
      const before = fake.requests;
      agent.write('a.txt を作って\n');
      // 依頼がモデルまで届いた（返事は来ない）ところで止める
      await until(() => fake.requests > before, `依頼がモデルへ届かない:\n${agent.output().slice(-600)}`);
      agent.kill('SIGINT');
      agent.write('/exit\n');
      const code = await within(agent.exited, 15_000);
      assert.notEqual(code, 'timeout', `止めた後の /exit で終わらない（依頼が止まっていない）:\n${agent.output().slice(-800)}`);
      assert.equal(code, 0, agent.output().slice(-800));
    } finally { agent.kill('SIGKILL'); }
  });

  test('**止めていないときも、/exit ですぐ終わる**（考えごとの時計が残らない）', async () => {
    const agent = await startAgent();
    try {
      await until(() => /\/exit で終了/.test(agent.output()), `起動しない:\n${agent.output().slice(-600)}`);
      agent.write('/exit\n');
      const code = await within(agent.exited, 15_000);
      assert.notEqual(code, 'timeout', `/exit で終わらない:\n${agent.output().slice(-800)}`);
    } finally { agent.kill('SIGKILL'); }
  });

  test('**知らない / の命令は、依頼としてモデルへ送らない**', async () => {
    const agent = await startAgent();
    try {
      await until(() => /\/exit で終了/.test(agent.output()), `起動しない:\n${agent.output().slice(-600)}`);
      const before = fake.requests;
      agent.write('/exti\n');
      await until(() => /知らない命令/.test(agent.output()), `知らない命令と言わない:\n${agent.output().slice(-600)}`);
      assert.equal(fake.requests, before, '打ち間違いの命令をモデルへ送った');
      agent.write('/exit\n');
      assert.notEqual(await within(agent.exited, 15_000), 'timeout');
    } finally { agent.kill('SIGKILL'); }
  });
});

describe('テストの出力の読み方', () => {
  // 調査では CRLF で読み違えると挙がったが、JS の m フラグの $ は \r の前でも当たる。読み違えないことを固定しておく
  test('CRLF の出力でも、落ちた件数 0 を通ったと読む', () => {
    assert.equal(testsPassed('# tests 3\r\n# pass 3\r\n# fail 0\r\n# cancelled 0\r\n', 0), true);
    assert.equal(testsPassed('# tests 3\r\n# pass 2\r\n# fail 1\r\n', 1), false);
    assert.equal(testsPassed('# tests 3\r\n# fail 0\r\n# cancelled 1\r\n', 1), false);
  });
});

describe('報告のファイル', () => {
  test('**同じ分のうちに二度書いても、前のものを上書きしない**', async () => {
    const dir = await tempDir('aas-report-twice-');
    // 書く先を外から決める口が開いていると、そちらへ書く。この試験は渡した場所だけを見る
    const outside = process.env.AAS_REPORT_DIR;
    delete process.env.AAS_REPORT_DIR;
    after(() => { if (outside !== undefined) process.env.AAS_REPORT_DIR = outside; });
    const a = await saveReport('report', '一つ目', [dir]);
    const b = await saveReport('report', '二つ目', [dir]);
    assert.ok(a.path && b.path, JSON.stringify([a, b]));
    assert.notEqual(a.path, b.path);
    assert.equal((await readdir(dir)).filter((f) => f.startsWith('report-')).length, 2);
  });
});
