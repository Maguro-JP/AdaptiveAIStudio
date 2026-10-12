import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('履歴の走査は、消したファイルの古い中身に残った鍵も拾う', async () => {
  const repo = await tempDir('aas-scan-history-');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo });
  git('init', '-q');
  // 作り物の鍵（形だけ本物に似せる）
  await writeFile(join(repo, 'old.txt'), `token ${'ghp_' + 'A'.repeat(36)}\n`);
  await writeFile(join(repo, 'keep.txt'), 'ふつうの文\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  await rm(join(repo, 'old.txt'));
  git('add', '-A');
  git('commit', '-qm', 'two');
  const out = execFileSync(process.execPath, [join(root, 'scripts/scan-history.mjs'), '--repo', repo], { encoding: 'utf8' });
  // 当たる種類は鍵の一つだけ（種類の名前は検問の側が決める）
  assert.equal((out.match(/^== /gm) ?? []).length, 1);
  assert.match(out, /^== .+: 1 件$/m);
  assert.match(out, /old\.txt/);
  assert.doesNotMatch(out, /A{20}/, '鍵そのものは出さない');
});
