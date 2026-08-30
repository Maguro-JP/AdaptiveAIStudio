/**
 * 試験の走らせ役。
 *
 * `node --test test/*.test.ts` を npm から直に呼ぶと、環境によって壊れる。
 *   ・Windows の cmd.exe は `*` を展開しない。展開の可否が Node の版と殻に依存する
 *   ・型を剥がす指定は、版によって要ったり要らなかったりする
 * どちらも「こちらの作りは正しいのに走らない」形で出るので、
 * 走らせ方の差はここに閉じ込め、npm からは常に同じ呼び方にする。
 *
 * 使い方:
 *   node scripts/run-tests.mjs            すべて
 *   node scripts/run-tests.mjs gguf env   名前に含むものだけ
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
  .sort()
  // 殻に頼らず、こちらで並べて渡す。
  .map((f) => join('test', f));

if (files.length === 0) {
  console.error(filters.length ? `該当する試験がありません: ${filters.join(', ')}` : '試験が1つもありません');
  process.exit(1);
}

/**
 * 型を剥がす指定が要るかどうか。
 * v22.18 / v23.6 以降は既定で剥がれるので、付けると警告になる版がある。
 */
function needsStripFlag(version) {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major >= 24) return false;
  if (major === 23) return minor < 6;
  if (major === 22) return minor < 18;
  return true;
}

const args = [
  '--no-warnings',
  ...(needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : []),
  '--test',
  ...files,
];

const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('error', (e) => { console.error(e.message); process.exit(1); });
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
