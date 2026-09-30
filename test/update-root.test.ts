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

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

test('作業場の上流が進んでいても、それを製品の更新として出さない', async () => {
  // 上流（bare）と、一つ遅れた作業場を作る
  const base = await tempDir('aas-update-root-repo-');
  const upstream = join(base, 'up.git');
  const seed = join(base, 'seed');
  const work = join(base, 'work');
  git(base, 'init', '-q', '--bare', upstream);
  git(base, 'clone', '-q', upstream, seed);
  await writeFile(join(seed, 'a.txt'), '1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'first');
  git(seed, 'push', '-q', 'origin', 'HEAD');
  git(base, 'clone', '-q', upstream, work);
  await writeFile(join(seed, 'a.txt'), '2\n');
  git(seed, 'commit', '-q', '-am', 'USER-PROJECT-ONLY-COMMIT');
  git(seed, 'push', '-q', 'origin', 'HEAD');
  const headBefore = git(work, 'rev-parse', 'HEAD').trim();

  // 製品が入っている場所は、ネットワークに出ない別の場所（git の無いフォルダ）にする。試験を走らせているリポジトリに fetch をかけない
  const product = await tempDir('aas-update-root-product-');
  const server = new UiServer({ port: 0, updateRoot: product, config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, root: work } } as typeof DEFAULT_CONFIG });
  const url = (await server.start()).replace(/\/$/, '');
  try {
    const r = await fetch(`${url}/api/update`);
    const status = await r.json() as { incoming?: string[] };
    assert.equal(r.status, 200);
    assert.ok(!(status.incoming ?? []).some((s) => s.includes('USER-PROJECT-ONLY-COMMIT')), `作業場の変更を製品の更新として出した: ${JSON.stringify(status)}`);
    assert.equal(git(work, 'rev-parse', 'HEAD').trim(), headBefore, '確かめるだけで作業場が動いた');
  } finally { await server.stop(); }
});
