/**
 * 保護パターンの照合。
 *
 * ここが当たらないと、**守っているつもりで守れていない**。
 * 既定の保護に `.git/**` が入っていたのに、何にも当たっていなかった。
 * 当たる側と当たらない側の両方を置く。片方だけだと
 * 「常に真」「常に偽」で通ってしまう。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { minimatch } from '../src/harness/glob.ts';

/** 当たるべき組と、当たってはいけない組。 */
const HIT: [string, string][] = [
  ['.git/config', '.git/**'],
  ['.git/hooks/pre-commit', '.git/**'],
  ['secrets/key.txt', 'secrets/**'],
  ['secrets/a/b/key.txt', 'secrets/**'],
  ['a.ts', '**/*.ts'],
  ['src/a.ts', '**/*.ts'],
  ['src/deep/a.ts', '**/*.ts'],
  ['credentials.json', '**/credentials*'],
  ['app/credentials.json', '**/credentials*'],
  ['.env', '.env'],
  ['.env.local', '.env.*'],
  ['pnpm-lock.yaml', 'pnpm-lock.yaml'],
  ['a/b.lock', '**/*.lock'],
  ['src/a.ts', 'src/*.ts'],
  ['src/a.ts', 'src/?.ts'],
];

const MISS: [string, string][] = [
  ['src/deep/a.ts', 'src/*.ts'],
  ['other/key.txt', 'secrets/**'],
  ['gitignore', '.git/**'],
  ['a.js', '**/*.ts'],
  ['src/ab.ts', 'src/?.ts'],
  // `.` は普通の文字として扱う。正規表現の「何でも1文字」にしない。
  ['aenv', '.env'],
];

describe('保護パターンの照合', () => {
  for (const [path, pattern] of HIT) {
    test(`当たる: ${pattern} ← ${path}`, () => {
      assert.equal(minimatch(path, pattern), true);
    });
  }
  for (const [path, pattern] of MISS) {
    test(`当たらない: ${pattern} ← ${path}`, () => {
      assert.equal(minimatch(path, pattern), false);
    });
  }
  test('Windows の区切りでも同じに見る', () => {
    assert.equal(minimatch('.git\\config', '.git/**'), true);
  });
});

describe('大小を区別しない機械の守り', () => {
  test('nocase なら .ENV も .env', () => {
    assert.equal(minimatch('.ENV', '.env', { nocase: true }), true);
    assert.equal(minimatch('Secrets/Key.txt', 'secrets/**', { nocase: true }), true);
  });
  test('既定では区別する（対）。Linux では別のファイル', () => {
    assert.equal(minimatch('.ENV', '.env'), false);
  });
});
