import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// selftest はテストを最後まで回してから結果を出す。回し始める前に一言出さないと、使う人には止まって見える。
test('selftest は、長いテストを回す前に、回していることと目安の時間を言う', async () => {
  const src = await readFile(join(import.meta.dirname, '..', 'src', 'cli', 'selftest.ts'), 'utf8');
  const say = src.indexOf('テストを回しています');
  const run = src.indexOf("join(root, 'scripts', 'run-tests.mjs')");
  assert.ok(say > 0 && run > 0 && say < run);
});
