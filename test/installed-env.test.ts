/**
 * 入れた機械の env で走らせても、テストが落ちないこと。
 *
 * インストーラが書く入口は `set "AAS_HOME=%COMMONPROGRAMDATA%\AdaptiveAIStudio"`
 * を立てる（`installer/AdaptiveAIStudio.nsi`）。`npm run selftest` はその入口から
 * 走るので、**入れた機械では毎回その env が立っている。**
 *
 * `test/home.test.ts` は根を決める env を `afterEach` でしか消していなかったので、
 * 外から立っていると一つ目のテストがそのまま落ちる。**壊れていないのに
 * 「NG」と言うテストは、あるほうが悪い**（直しに行く先が無い）。
 *
 * ここは子として起こして確かめる。**同じプロセスで env を立てると、
 * 立てたことが他のファイルへ漏れる。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { installRoot } from '../src/core/home.ts';

const run = promisify(execFile);

/** その一つのファイルを、env を立てた子で走らせる。 */
async function runWith(file: string, env: Record<string, string>): Promise<{ ok: boolean; text: string }> {
  /*
   * **走らせている側の env を、そのまま渡さない。**
   *
   * node の試験の走らせ手は `NODE_TEST_CONTEXT` を立てる。それを継ぐと、
   * 子は「試験の子」として振る舞い、**中身を走らせずに終わる。**
   * 69ms で終わって通ったので、しばらく効いていないことに気づけなかった。
   */
  const clean = { ...process.env };
  delete clean.NODE_TEST_CONTEXT;
  delete clean.NODE_OPTIONS;
  for (const k of ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR']) delete clean[k];
  const out = await run(process.execPath, [
    /*
     * **数え方を、こちらで決める。**
     *
     * node の既定の出し方は版で変わる（24 では `✔` と `ℹ pass 49`、
     * 22 では `# pass 49`）。`# pass` だけを見ていたので、**Windows の CI
     * （Node 24）でだけ「子が中身を走らせていない」で落ちた。**子は 49 件
     * 通していたのに、読み方が合っていなかっただけ。
     * 走らせる場所で結果が変わる試験にしないため、出し方を固定する。
     */
    '--test-reporter=tap',
    '--experimental-strip-types', '--no-warnings', '--test', join(installRoot(), 'test', file),
  ], { env: { ...clean, ...env, NO_COLOR: '1' }, timeout: 300_000 })
    .then((r) => ({ ok: true, ...r }))
    .catch((e: { stdout?: string; stderr?: string }) => ({ ok: false, ...e }));
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  // **走っていないものを「通った」と読まない。**件数の行が無ければ、走っていない。
  const ran = /^# pass (\d+)/m.exec(text);
  assert.ok(ran && Number(ran[1]) > 0, `子が中身を走らせていない:\n${text.slice(-600)}`);
  return { ok: out.ok, text };
}

describe('入れた機械の env でも、テストは通る', () => {
  test('**AAS_HOME が立っていても、根を決めるテストは通る**', async () => {
    const home = join(tmpdir(), 'aas-installed-probe');
    const got = await runWith('home.test.ts', { AAS_HOME: home });
    assert.ok(got.ok, `入れた機械と同じ env で落ちる:\n${got.text.slice(-1200)}`);
  });

  test('個別の指定が立っていても通る', async () => {
    const home = join(tmpdir(), 'aas-installed-probe');
    const got = await runWith('home.test.ts', {
      AAS_STATE_DIR: join(home, 'state'),
      AAS_MODELS_DIR: join(home, 'models'),
      AAS_BIN_DIR: join(home, 'bin'),
    });
    assert.ok(got.ok, `個別の指定で落ちる:\n${got.text.slice(-1200)}`);
  });
});

/**
 * フックの中から走らせても、テストが落ちないこと。
 *
 * git は pre-push へ `GIT_DIR` や `GIT_INDEX_FILE` を渡す。継いだまま回すと、
 * 一時の repository を作るテストが**走らせている repository** を触りにいって落ちる。
 * 手で回すと通り、フックからだけ 21 件落ちた。**確かめの側が嘘をつくと、
 * 確かめを迂回する癖がつく**（--no-verify を覚える）。
 */
describe('フックの env でも、テストは通る', () => {
  test('**GIT_DIR が立っていても、渡す道のテストは通る**', async () => {
    const got = await runWith('handoff-e2e.test.ts', {
      GIT_DIR: join(installRoot(), '.git'),
      GIT_INDEX_FILE: join(tmpdir(), 'aas-hook-probe.idx'),
    });
    assert.ok(got.ok, `フックと同じ env で落ちる:\n${got.text.slice(-1200)}`);
  });

  test('フックが、その env を落としている', async () => {
    const { readFile } = await import('node:fs/promises');
    const hook = await readFile(join(installRoot(), '.githooks', 'pre-push'), 'utf8');
    assert.match(hook, /unset GIT_DIR/, 'フックが env を落としていない');
  });
});
