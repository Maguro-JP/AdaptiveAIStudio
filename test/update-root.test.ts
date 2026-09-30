/**
 * 画面の「更新を確認する」は、製品が入っている場所を見る。利用者の作業場（利用者のプロジェクト）を見ない。
 *
 * 作業場を根にして git fetch と merge --ff-only をかけていたので、利用者のプロジェクトの上流の新しい変更が「製品の更新」として出て、
 * 取り込むと利用者のブランチを早送りし、「立ち上げ直してください」と言っていた。立ち上げ直しても製品は新しくならない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-update-root-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

// git の無い機械（配った形の Windows）では飛ばす。利用者の全体の設定（commit への署名など）は受けない
const GIT_OK = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

/** 上流（bare）と、一つ遅れた clone を作る。上流の新しい変更の見出しは `subject`。 */
async function behindByOne(base: string, name: string, subject: string): Promise<string> {
  const upstream = join(base, `${name}-up.git`);
  const seed = join(base, `${name}-seed`);
  const clone = join(base, name);
  git(base, 'init', '-q', '--bare', upstream);
  git(base, 'clone', '-q', upstream, seed);
  await writeFile(join(seed, 'a.txt'), '1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'first');
  git(seed, 'push', '-q', 'origin', 'HEAD');
  git(base, 'clone', '-q', upstream, clone);
  await writeFile(join(seed, 'a.txt'), '2\n');
  git(seed, 'commit', '-q', '-am', subject);
  git(seed, 'push', '-q', 'origin', 'HEAD');
  return clone;
}

test('作業場の上流が進んでいても、それを製品の更新として出さず、渡した製品の場所を見る', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  const base = await tempDir('aas-update-root-repo-');
  const work = await behindByOne(base, 'work', 'USER-PROJECT-ONLY-COMMIT');
  // 製品の場所も、ネットワークに出ない手元の上流つきの clone にする（渡した場所を本当に見ていることを、その変更が出ることで見る）
  const product = await behindByOne(base, 'product', 'PRODUCT-UPDATE-COMMIT');
  const headBefore = git(work, 'rev-parse', 'HEAD').trim();

  const server = new UiServer({ port: 0, updateRoot: product, config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, root: work } } as typeof DEFAULT_CONFIG });
  const url = (await server.start()).replace(/\/$/, '');
  try {
    const r = await fetch(`${url}/api/update`);
    const status = await r.json() as { incoming?: string[] };
    assert.equal(r.status, 200);
    assert.ok(!(status.incoming ?? []).some((s) => s.includes('USER-PROJECT-ONLY-COMMIT')), `作業場の変更を製品の更新として出した: ${JSON.stringify(status)}`);
    assert.ok((status.incoming ?? []).some((s) => s.includes('PRODUCT-UPDATE-COMMIT')), `渡した製品の場所を見ていない: ${JSON.stringify(status)}`);
    assert.equal(git(work, 'rev-parse', 'HEAD').trim(), headBefore, '確かめるだけで作業場が動いた');
  } finally { await server.stop(); }
});
