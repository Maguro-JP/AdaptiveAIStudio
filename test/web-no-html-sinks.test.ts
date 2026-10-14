import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 画面に描く文は、モデルの答え・ツールの出力・ファイル名のように外から来る。文字列を HTML として流し込む書き方を、
// 画面の JS のどこにも置かない（要素を作り、文字は textContent で入れる）。コメントの中は見ない
const web = join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web');
const SINKS = /\.innerHTML\s*[+]?=|\.outerHTML\s*[+]?=|insertAdjacentHTML\s*\(|document\.write\s*\(|new\s+Function\s*\(|\beval\s*\(|\.srcdoc\s*=|createContextualFragment\s*\(/;

test('画面の JS に、文字列を HTML として流し込む書き方が無い', () => {
  const found: string[] = [];
  for (const name of readdirSync(web).filter((n) => n.endsWith('.js'))) {
    const code = readFileSync(join(web, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    code.split('\n').forEach((line, i) => { if (SINKS.test(line)) found.push(`${name}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(found, []);
});

test('見張りが効く（流し込む書き方を入れると当たる）', () => {
  assert.ok(SINKS.test('box.innerHTML = text'));
  assert.ok(SINKS.test("el.insertAdjacentHTML('beforeend', s)"));
  assert.ok(!SINKS.test('box.textContent = text'));
});
