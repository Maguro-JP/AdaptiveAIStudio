/**
 * 利用者に「消す」ことを勧める文言は、戻せる手とセットにする。
 *
 * 設定が壊れたときの案内が「このファイルを消せば既定で動きます」だった。案内どおりに消した設定（繋ぎ先・役職など）は戻らない。
 * 名前を変える・写しを取る・取り直せる、のどれかを同じ文の中で言っていない「消す案内」を、ここで止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const installer = join(root, 'installer');

/**
 * installer は bundle に入らない（作業場にしか無い）。在るかで決めず、bundle であること（一つ上に `.portable`）か、
 * git の clone でないことで決める（在るかで決めると、消したとき黙って飛ぶ）。
 */
const inBundle = existsSync(join(root, '..', '.portable')) || !existsSync(join(root, '.git'));
const sourceOnly = inBundle ? { skip: 'installer は作業場にしか無いので、bundle では確かめられません' } : {};

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, pattern) : pattern.test(n) ? [p] : [];
  });
}

/** 利用者に消すことを勧める言い方。 */
const ADVISES_DELETE = /(消せば|消してください|消して取り直|削除してください|削除すれば)/;
/** 戻せる手。どれか一つを同じ文字列の中で言う。 */
const RECOVERABLE = /(名前を変え|写しを取|取り直|\.bak)/;

/** 文字列（引用符・テンプレート）の中にある、戻せる手の無い消す案内。注釈は利用者に出ないので見ない */
function unsafeAdvice(dir: string, pattern: RegExp): string[] {
  const bad: string[] = [];
  for (const file of files(dir, pattern)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const strings = line.match(/'[^']*'|`[^`]*`|"[^"]*"/g) ?? [];
      for (const s of strings) {
        if (ADVISES_DELETE.test(s) && !RECOVERABLE.test(s)) bad.push(`${file.slice(root.length + 1)}:${i + 1}: ${s.slice(0, 80)}`);
      }
    });
  }
  return bad;
}

test('**利用者に消すことを勧める文言は、名前を変える・写しを取る・取り直す、のどれかと一緒に言う**', () => {
  const bad = unsafeAdvice(src, /\.(ts|js)$/);
  assert.deepEqual(bad, [], `戻せる手の無い「消す案内」:\n${bad.join('\n')}`);
});

// アンインストールの後に出す案内も、利用者が読んでそのとおりに消す文
test('**installer が出す消す案内も、写しの取り方と一緒に言う**', sourceOnly, () => {
  const bad = unsafeAdvice(installer, /\.(nsi|cmd)$/);
  assert.deepEqual(bad, [], `戻せる手の無い「消す案内」:\n${bad.join('\n')}`);
});
