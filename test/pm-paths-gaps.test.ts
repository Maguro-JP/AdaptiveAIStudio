/**
 * 書き込み先の綴りの揺れ（96 回目の調査）。
 *
 * - `normalizeWrite` は一つ目の `./` だけを外していたので、`././src/a.ts`・`src//a.ts`・`src/./a.ts` が `src/a.ts` と別の書き込み先になり、
 *   同じファイルを書く作業が同時に走りえた
 * - 検収は綴りで比べていたので、計画にある `./src/a.ts` を「計画に無いファイルが変わっています」と言っていた
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWrite } from '../src/agent/pm.ts';
import { judge } from '../src/agent/acceptance.ts';

test('書き込み先の綴りの揺れを畳む', () => {
  for (const p of ['src/a.ts', './src/a.ts', '././src/a.ts', 'src//a.ts', 'src/./a.ts', 'src/x/../a.ts', '.\\src\\a.ts', '/src/a.ts']) {
    assert.equal(normalizeWrite(p), 'src/a.ts', p);
  }
  assert.equal(normalizeWrite('src/'), 'src/', 'フォルダの指定は残す');
});

test('検収は綴りではなくファイルで比べる', () => {
  const v = judge({ members: [], changed: ['src/a.ts'], declared: ['./src/a.ts'], verified: 'passed' } as never) as { concerns?: Array<{ reason: string }> };
  assert.doesNotMatch(JSON.stringify(v), /計画に無いファイル/, JSON.stringify(v));
});
