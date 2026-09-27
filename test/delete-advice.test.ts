/**
 * 利用者に「消す」ことを勧める文言は、戻せる手とセットにする。
 *
 * 設定が壊れたときの案内が「このファイルを消せば既定で動きます」だった。案内どおりに消した設定（繋ぎ先・役職など）は戻らない。
 * 名前を変える・写しを取る・取り直せる、のどれかを同じ文の中で言っていない「消す案内」を、ここで止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js)$/.test(n) ? [p] : [];
  });
}

/** 利用者に消すことを勧める言い方。 */
const ADVISES_DELETE = /(消せば|消してください|消して取り直|削除してください|削除すれば)/;
/** 戻せる手。どれか一つを同じ文字列の中で言う。 */
const RECOVERABLE = /(名前を変え|写しを取|取り直|\.bak)/;

test('**利用者に消すことを勧める文言は、名前を変える・写しを取る・取り直す、のどれかと一緒に言う**', () => {
  const bad: string[] = [];
  for (const file of files(src)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // 注釈は利用者に出ない。文字列（引用符・テンプレート）の中だけを見る
      const strings = line.match(/'[^']*'|`[^`]*`|"[^"]*"/g) ?? [];
      for (const s of strings) {
        if (ADVISES_DELETE.test(s) && !RECOVERABLE.test(s)) bad.push(`${file.slice(src.length + 1)}:${i + 1}: ${s.slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bad, [], `戻せる手の無い「消す案内」:\n${bad.join('\n')}`);
});
