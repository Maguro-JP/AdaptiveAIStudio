/**
 * 差分の行数は、中身が `--` や `++` で始まる行も数える。
 *
 * 見出し（`--- a/…`・`+++ b/…`）を飛ばすのに、塊の中の行まで `---`・`+++` で始まるかで見ていた。SQL の注釈（`-- …`）を消した行は
 * `--- …` になるので数えず、画面の「+n -m」が実際より少なく出ていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff, diffStat } from '../src/agent/diff.ts';

test('中身が -- や ++ で始まる行の出入りも数える', () => {
  const before = '-- 古い注釈\nSELECT 1;\n';
  const after = '++i;\nSELECT 1;\n';
  const diff = unifiedDiff('a.sql', before, after);
  assert.deepEqual(diffStat(diff), { added: 1, removed: 1 });
});

test('見出しは数えない（対）', () => {
  const diff = unifiedDiff('a.txt', 'a\n', 'b\n');
  assert.match(diff, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n/);
  assert.deepEqual(diffStat(diff), { added: 1, removed: 1 });
});

test('\\ で区切った試験の道も、試験のファイルとして見る', async () => {
  const { isTestFile } = await import('../src/harness/builtin-rules.ts');
  assert.equal(isTestFile('tests\\test_api.py'), true);
  assert.equal(isTestFile('src\\__tests__\\a.test.ts'), true);
  assert.equal(isTestFile('tests/test_api.py'), true);
  assert.equal(isTestFile('src\\a.ts'), false);
});
