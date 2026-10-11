import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact.ts';

test('短いパスワードと日本語の名前も伏せる', () => {
  for (const [input, secret] of [
    ['password: hunter2', 'hunter2'],
    ['pwd=ab12', 'ab12'],
    ['パスワードは S3cr3t!x です', 'S3cr3t!x'],
    ['暗証番号：1234', '1234'],
  ] as const) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `${input} → ${out}`);
    assert.ok(out.includes('（伏せました）'), out);
  }
});

test('型の名前や地の文は伏せない', () => {
  for (const input of ['password: string', 'interface A { password: string; }', 'パスワードを忘れたとき']) {
    assert.equal(redactSecrets(input), input);
  }
});
