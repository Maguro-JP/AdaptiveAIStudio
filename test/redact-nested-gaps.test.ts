/**
 * 85 回目の不具合調査（下回りの部品）の分。
 *
 * 文字列の中に入った JSON（ツールの引数は JSON を文字列にした形で来る）でも、秘密の項目を伏せる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact.ts';

test('**文字列の中の JSON の秘密の項目も伏せる**', () => {
  const inner = JSON.stringify({ password: 'hunter2pass', path: 'a.ts' });
  const out = redactSecrets(JSON.stringify({ args: inner }));
  assert.doesNotMatch(out, /hunter2pass/, out);
  assert.match(out, /a\.ts/, `秘密でない項目まで消した: ${out}`);
  const out2 = redactSecrets(JSON.stringify({ arguments: JSON.stringify({ api_key: 'abcdefghijklmnopqrst' }) }));
  assert.doesNotMatch(out2, /abcdefghijklmnopqrst/, out2);
});

test('伏せた後も、文字列の中の JSON として読める', () => {
  const out = redactSecrets(JSON.stringify({ args: JSON.stringify({ token: 'x'.repeat(20), n: 1 }) }));
  const back = JSON.parse(JSON.parse(out).args) as { token: string; n: number };
  assert.equal(back.n, 1);
  assert.notEqual(back.token, 'x'.repeat(20));
});
