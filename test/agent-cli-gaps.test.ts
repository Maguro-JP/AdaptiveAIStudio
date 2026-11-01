/**
 * CLI の小物の不具合（39 回目の調査）。端末の `aas agent` の入口は、アプリケーション版に絞ったので消した。
 *
 * - 同じ分のうちに二度書いた報告を、上書きしない
 * - 改行が CRLF のテストの出力でも、通ったと読む（これは前から読めていた。固定しておく）
 * - 閉じるときに、待たずに走らせた判じ手も止める（`/exit` の後に残らない）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';
import { testsPassed } from '../src/cli/tests-verdict.ts';
import { saveReport } from '../src/cli/report-file.ts';
import { REPORT_NAME, reportOrder } from '../src/runtime/cleanup.ts';

describe('テストの出力の読み方', () => {
  // 調査では CRLF で読み違えると挙がったが、JS の m フラグの $ は \r の前でも当たる。読み違えないことを固定しておく
  test('CRLF の出力でも、落ちた件数 0 を通ったと読む', () => {
    assert.equal(testsPassed('# tests 3\r\n# pass 3\r\n# fail 0\r\n# cancelled 0\r\n', 0), true);
    assert.equal(testsPassed('# tests 3\r\n# pass 2\r\n# fail 1\r\n', 1), false);
    assert.equal(testsPassed('# tests 3\r\n# fail 0\r\n# cancelled 1\r\n', 1), false);
  });
});

describe('報告の名前の並び', () => {
  test('**同じ分の -2 -10 も、読む側が同じ名前として古い順に並べる**', () => {
    const names = ['doctor-20261005-0517-10.txt', 'doctor-20261005-0518.txt', 'doctor-20261005-0517-2.txt', 'doctor-20261005-0517.txt'];
    assert.deepEqual([...names].sort(reportOrder), [
      'doctor-20261005-0517.txt', 'doctor-20261005-0517-2.txt', 'doctor-20261005-0517-10.txt', 'doctor-20261005-0518.txt',
    ]);
    assert.equal(REPORT_NAME.exec('doctor-20261005-0517-2.txt')?.[1], 'doctor');
    assert.equal(REPORT_NAME.exec('self-test-20261005-0517.txt')?.[1], 'self-test');
  });
});

describe('報告のファイル', () => {
  test('**同じ分のうちに二度書いても、前のものを上書きしない**', async () => {
    const dir = await tempDir('aas-report-twice-');
    // 書く先を外から決める口が開いていると、そちらへ書く。この試験は渡した場所だけを見る
    const outside = process.env.AAS_REPORT_DIR;
    delete process.env.AAS_REPORT_DIR;
    after(() => { if (outside !== undefined) process.env.AAS_REPORT_DIR = outside; });
    const a = await saveReport('report', '一つ目', [dir]);
    const b = await saveReport('report', '二つ目', [dir]);
    assert.ok(a.path && b.path, JSON.stringify([a, b]));
    assert.notEqual(a.path, b.path);
    assert.equal((await readdir(dir)).filter((f) => f.startsWith('report-')).length, 2);
  });
});
