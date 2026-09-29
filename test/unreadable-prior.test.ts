/**
 * 前の中身を読めないとき、「無い」と取り違えて消す・書き直す形を止める。
 *
 *   ・`.env` を読めないのを空と読み、一行足して丸ごと書き直していた（ほかのトークンが全部消えた）
 *   ・git が落ちたのを「HEAD に無い」と読み、戻すときに HEAD に在るファイルを消していた
 *   ・外のツールの前に stat できなかったファイルを「前は無い」と記録し、戻すときに消していた
 *
 * 読めなさは fs/promises の関数をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { writeEnvValue } from '../src/core/env.ts';
import { headContent } from '../src/agent/workspace-stamp.ts';
import { OutsideChanges } from '../src/agent/outside-changes.ts';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

/** fs/promises の `name` を、`path` のときだけ `code` で失敗させて `fn` を回す。 */
async function failing<T>(name: 'readFile' | 'stat', path: string, code: string, fn: () => Promise<T>): Promise<T> {
  const real = fsp[name] as (...a: unknown[]) => Promise<unknown>;
  (fsp as Record<string, unknown>)[name] = ((file: unknown, ...rest: unknown[]) => file === path
    ? Promise.reject(Object.assign(new Error(`${code}: ${name} failed`), { code }))
    : real(file, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as Record<string, unknown>)[name] = real;
    syncBuiltinESMExports();
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('.env を読めないとき', () => {
  test('書き直さず、ほかのトークンを残す', async () => {
    const path = join(await tempDir('aas-unreadable-env-'), '.env');
    await writeFile(path, 'OTHER=1\nKEEP=2\n');
    await assert.rejects(failing('readFile', path, 'EBUSY', () => writeEnvValue(path, 'GITHUB_TOKEN', 'x')), /読めないので書き換えません/);
    assert.equal(await readFile(path, 'utf8'), 'OTHER=1\nKEEP=2\n', 'ほかのトークンを消した');
  });
});

describe('git から前の中身を取れないとき', () => {
  test('git が落ちたら「無い」ではなく「取れない」と言う。HEAD に無いだけなら「無い」', async () => {
    const root = join(await tempDir('aas-unreadable-head-'), 'repo');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.txt'), 'a\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    assert.deepEqual(await headContent(root, 'a.txt', 1024), { kind: 'content', content: 'a\n' });
    assert.deepEqual(await headContent(root, 'b.txt', 1024), { kind: 'absent' });
    // git そのものが落ちる（リポジトリでない所で走らせる）
    const notRepo = await tempDir('aas-unreadable-head-none-');
    assert.deepEqual(await headContent(notRepo, 'a.txt', 1024), { kind: 'unavailable', why: 'unreadable' },
      'git が落ちたのを「HEAD に無い」と読んだ');
  });

  test('まだ一度もコミットしていないリポジトリでは、HEAD に何も無いので「無い」', async () => {
    const root = join(await tempDir('aas-unreadable-head-fresh-'), 'repo');
    await mkdir(root, { recursive: true });
    git(root, 'init', '-q');
    await writeFile(join(root, 'new.txt'), 'new\n');
    assert.deepEqual(await headContent(root, 'new.txt', 1024), { kind: 'absent' }, '作ったばかりのファイルを戻せない形にした');
  });
});

describe('外のツールの前に、変わっていたファイルを stat できないとき', () => {
  test('「前は無い」と記録せず、記録できなかった道にする', async () => {
    const root = join(await tempDir('aas-unreadable-outside-'), 'repo');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'dirty.txt'), 'committed\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    // 呼ぶ前から変わっている（前の中身は呼ぶ前に読む道）
    await writeFile(join(root, 'dirty.txt'), 'edited before\n');
    const outside = new OutsideChanges(root);
    await failing('stat', join(root, 'dirty.txt'), 'EACCES', () => outside.before());
    // 外のツールが書き換えた
    await writeFile(join(root, 'dirty.txt'), 'edited by tool\n');
    const r = await outside.after();
    assert.deepEqual(r.changes.filter((c) => c.path === 'dirty.txt'), [], `「前は無い」と記録した: ${JSON.stringify(r.changes)}`);
    assert.deepEqual(r.unrecorded, ['dirty.txt']);
  });
});
