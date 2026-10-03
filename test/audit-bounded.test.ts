/**
 * 監査の記録を、際限なく溜めない。
 *
 * 通った呼び出しも毎回記録するので、画面を開いたままにすると手元の記録は増え続け、ファイルも片づけの外で増え続けていた。
 * 手元は新しい分だけを持ち（数え上げは落とした分も数える）、ファイルは上限を超えたら一つ前（`.1`）へ回す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { AuditLog } from '../src/harness/audit.ts';

describe('監査の記録の上限', () => {
  test('手元は新しい分だけを持つ。数え上げは落とした分も数える', async () => {
    const audit = new AuditLog(undefined, { keep: 10 });
    for (let i = 0; i < 25; i += 1) await audit.record({ tool: `t${i}`, outcome: i % 5 === 0 ? 'denied' : 'allowed', rule: 'r' });
    const kept = audit.entries();
    assert.equal(kept.length, 10, `手元に ${kept.length} 件持っている`);
    assert.equal(kept[0]!.tool, 't15', '古い方から落としていない');
    const sum = audit.summary();
    assert.equal(sum.allowed + sum.denied, 25, '落とした分を数えていない');
    assert.equal(sum.denied, 5);
    assert.equal(sum.byRule.get('r'), 25);
  });

  test('ファイルは上限を超えたら一つ前へ回し、書き足しは続ける', async () => {
    const dir = await tempDir('aas-audit-bounded-');
    const path = join(dir, 'audit.jsonl');
    const audit = new AuditLog(path, { maxBytes: 2_000 });
    // 大きさは 100 件ごとに見るので、それを超えるまで書く
    for (let i = 0; i < 250; i += 1) await audit.record({ tool: 'read_file', outcome: 'allowed', summary: 'x'.repeat(40) });
    const now = (await stat(path)).size;
    const before = await stat(`${path}.1`).then((s) => s.size, () => -1);
    assert.ok(before > 0, '一つ前へ回していない');
    assert.ok(now < before + 20_000, `いまのファイルが上限を大きく超えて増え続けている: ${now}`);
    // 書き足しは続いている（最後の一件がいまのファイルにある）
    assert.match(await readFile(path, 'utf8'), /read_file/);
  });
});
