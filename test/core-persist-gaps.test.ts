/**
 * 記録まわりの src/core の不具合（43 回目の調査）。
 *
 * - 伏せる処理が、逃がした引用符を含む値・数の値・道の中のログイン・秘密鍵のかたまり・JWT・Google と AWS の一時的な鍵・
 *   小文字の名前（`~/.aws/credentials`）・`Authorization: Basic` を出さない。コードの `apiKey: string` は伏せない
 * - 時計が戻っても、名前を前に並べない・同じ名前を配らない
 * - 読めない時刻で、日付の表示が投げない
 * - 錠を測るための仮のファイルを残さない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { redactSecrets } from '../src/core/redact.ts';
import { idMaker } from '../src/core/ordered-id.ts';
import { jstDate, jstDateTime } from '../src/core/clock.ts';
import { withFileLock } from '../src/core/file-lock.ts';

describe('伏せる', () => {
  for (const [what, text, secret] of [
    ['逃がした引用符を含む値', '{"password":"ab\\"cdSECRETPART"}', 'SECRETPART'],
    ['数の値', '{"pin_password": 987654}', '987654'],
    ['道の中のログイン', 'git clone https://alice:hunter2pass@example.invalid/r.git', 'hunter2pass'],
    ['秘密鍵のかたまり', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAinner\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAinner'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'dozjgNryP4J3jVmNHl0w5N'],
    ['Google の鍵', `key AIza${'x'.repeat(35)}`, `AIza${'x'.repeat(35)}`],
    ['AWS の一時的な鍵', 'ASIAABCDEFGHIJKLMNOP', 'ASIAABCDEFGHIJKLMNOP'],
    ['~/.aws/credentials の書き方', 'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCY', 'wJalrXUtnFEMIK7MDENGbPxRfiCY'],
    ['YAML の書き方', 'api_key: sk0123456789abcdefXYZ', 'sk0123456789abcdefXYZ'],
    ['Authorization: Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ] as const) {
    test(`**${what}を出さない**`, () => {
      const out = redactSecrets(text);
      assert.ok(!out.includes(secret), `出した: ${out}`);
      assert.match(out, /伏せました/);
    });
  }

  for (const text of ['apiKey: string;', 'const token = req.headers.authorization;', 'max_tokens: 4096', 'password: process.env.DB_PASSWORD']) {
    test(`コードの ${JSON.stringify(text)} は伏せない`, () => {
      assert.equal(redactSecrets(text), text);
    });
  }

  test('大文字の .env の書き方は、前と同じく短い値も伏せる', () => {
    assert.equal(redactSecrets('GITHUB_TOKEN=abc'), 'GITHUB_TOKEN=（伏せました）');
  });
});

describe('時計が戻ったとき', () => {
  test('**名前を前に並べず、同じ名前を配らない**', () => {
    const make = idMaker('t-');
    const seeds = [0.5, 0.1, 0.9, 0.0];
    let i = 0;
    const rand = (): number => seeds[i++ % seeds.length]!;
    const t = Date.UTC(2026, 9, 6, 12);
    const ids = [make(t, rand), make(t - 3_600_000, rand), make(t - 3_600_000, rand), make(t - 7_200_000, rand)];
    assert.equal(new Set(ids).size, ids.length, `同じ名前を配った: ${ids.join(',')}`);
    assert.deepEqual([...ids].sort(), ids, `後に作った名前が前に並ぶ: ${ids.join(',')}`);
  });
});

describe('読めない時刻', () => {
  test('**日付の表示が投げない**', () => {
    assert.equal(jstDate('こわれた'), '（日付不明）');
    assert.equal(jstDateTime(Number.NaN), '（日時不明）');
    assert.equal(jstDate(Date.UTC(2026, 9, 5, 15)), '2026-10-06');
  });
});

describe('錠', () => {
  test('**時計のずれを測るための仮のファイルを残さない**', async () => {
    const dir = await tempDir('aas-core-persist-lock-');
    await withFileLock(join(dir, 'x.json'), async () => undefined);
    assert.deepEqual(await readdir(dir), []);
  });
});
