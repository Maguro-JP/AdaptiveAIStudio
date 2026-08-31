/**
 * 更新の検証。
 *
 * 本物の git リポジトリを2つ作って、実際に取ってこさせる。
 * 偽物で試すと「早送りできない場合」を作れないので、
 * ここは本物でやる（ネットワークには出ない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { checkUpdate, applyUpdate, describeUpdate } from '../src/core/update.ts';

function git(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, stdio: 'ignore' });
    c.on('error', () => resolve(-1));
    c.on('close', (code) => resolve(code ?? -1));
  });
}

/** 「向こう側」と、そこから複製した「手元」を用意する。 */
async function pair() {
  const origin = await tempDir('aas-origin-');
  await git(['init', '--bare', '-b', 'main'], origin);

  const seed = await tempDir('aas-seed-');
  await git(['init', '-b', 'main'], seed);
  await git(['config', 'user.email', 't@example.com'], seed);
  await git(['config', 'user.name', 'test'], seed);
  await writeFile(join(seed, 'a.txt'), '1\n');
  await git(['add', '.'], seed);
  await git(['commit', '-m', '最初'], seed);
  await git(['remote', 'add', 'origin', origin], seed);
  await git(['push', '-u', 'origin', 'main'], seed);

  const local = await tempDir('aas-local-');
  const root = join(local, 'repo');
  await git(['clone', origin, root], local);
  await git(['config', 'user.email', 't@example.com'], root);
  await git(['config', 'user.name', 'test'], root);

  /** 向こう側に新しい変更を積む。 */
  const advance = async (message: string) => {
    await writeFile(join(seed, 'a.txt'), `${message}\n`);
    await git(['add', '.'], seed);
    await git(['commit', '-m', message], seed);
    await git(['push', 'origin', 'main'], seed);
  };

  return { root, advance };
}

describe('更新', () => {
  test('新しいものが無ければ、最新だと言う', async () => {
    const { root } = await pair();
    const s = await checkUpdate(root);
    assert.equal(s.behind, 0);
    assert.equal(s.can, false, '取ってくるものが無いのに押せる状態になっている');
    assert.match(s.reason ?? '', /最新/);
  });

  test('新しいものがあれば、件数と見出しを見せる', async () => {
    const { root, advance } = await pair();
    await advance('二つ目の変更');

    const s = await checkUpdate(root);
    assert.equal(s.behind, 1);
    assert.equal(s.can, true, s.reason);
    assert.equal(s.incoming.length, 1);
    assert.match(s.incoming[0]!, /二つ目の変更/);
    assert.match(describeUpdate(s), /1件の変更があります/);
  });

  test('取ってくると、実際に新しくなる', async () => {
    const { root, advance } = await pair();
    await advance('新しい中身');

    const r = await applyUpdate(root);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.applied, 1);
    assert.equal(r.restartNeeded, true, '立ち上げ直しを促していない');

    // 改行を直書きで比べない。Windows の git は core.autocrlf で
    // 取り出すときに LF を CRLF へ変えるので、中身は同じでも一致しない。
    // 確かめたいのは「新しくなったか」であって、改行の作法ではない。
    const got = await readFile(join(root, 'a.txt'), 'utf8');
    assert.equal(got.replace(/\r\n/g, '\n'), '新しい中身\n');
    assert.equal((await checkUpdate(root)).behind, 0);
  });

  test('未コミットの変更があるときは、取ってこない', async () => {
    const { root, advance } = await pair();
    await advance('向こうの変更');
    await writeFile(join(root, 'a.txt'), '手元でいじった\n');

    const s = await checkUpdate(root);
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /未コミットの変更/);

    const r = await applyUpdate(root);
    assert.equal(r.ok, false, '未コミットの変更を巻き込んでいる');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '手元でいじった\n', '手元の変更が失われた');
  });

  test('こちらにしか無い変更があるときは、早送りしない', async () => {
    const { root, advance } = await pair();
    await advance('向こうの変更');
    await writeFile(join(root, 'b.txt'), 'こちらの変更\n');
    await git(['add', '.'], root);
    await git(['commit', '-m', 'こちらの変更'], root);

    const s = await checkUpdate(root);
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /早送りできない/);
    assert.equal((await applyUpdate(root)).ok, false);
  });

  test('git 管理下でなければ、そう言って断る', async () => {
    const dir = await tempDir('aas-nogit-');
    await mkdir(join(dir, 'sub'), { recursive: true });
    const s = await checkUpdate(join(dir, 'sub'));
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /git 管理下ではありません/);
  });
});
