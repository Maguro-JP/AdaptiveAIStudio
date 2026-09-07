/**
 * 見たものを、ファイルに一つ残す。
 *
 * `doctor` も `selftest` も「そのまま貼ってください」で終わっていた。
 * cmd の画面から文字を拾うのは Windows ではとても面倒で（右クリック→範囲
 * 選択→Enter、途中で切れる）、結局「試す係をやってください」と同じになる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { saveReport, tellWhereItWent, plain, stamp } from '../src/cli/report-file.ts';

describe('報告を、ファイルに残す', () => {
  test('押した場所の隣に置く', async () => {
    const dir = await tempDir('aas-report-');
    const saved = await saveReport('doctor', '中身です', [dir]);
    assert.ok(saved.path, `置けていない: ${saved.why}`);
    assert.ok(saved.path.startsWith(dir), `隣に置いていない: ${saved.path}`);
    assert.equal(await readFile(saved.path, 'utf8'), '中身です');
  });

  test('**書けなければ、次の場所へ逃がす**', async () => {
    // Program Files に入れた形では、隣に書けない。そこで諦めない。
    const locked = join(await tempDir('aas-report-lock-'), 'ここには作れない');
    const ok = await tempDir('aas-report-ok-');
    await chmod(await tempDir('aas-report-lock2-'), 0o500).catch(() => undefined);
    const saved = await saveReport('doctor', 'x', [`${locked}\0だめ`, ok]);
    assert.ok(saved.path, `逃がせていない: ${saved.why}`);
    assert.ok(saved.path.startsWith(ok));
  });

  test('全部だめでも、投げない（理由を返す）', async () => {
    const saved = await saveReport('doctor', 'x', ['\0だめ']);
    assert.equal(saved.path, undefined);
    assert.ok(saved.why && saved.why.length > 0, '理由を返していない');
  });

  test('**色を落とす。ESC が入ると読めない**', () => {
    assert.equal(plain('\x1b[32mok\x1b[0m 版'), 'ok 版');
  });

  test('名前の時刻は JST', () => {
    // 機械の側は UTC でよいが、**人に見せるときは JST に直す**。
    // 2026-09-07 20:00 UTC は、JST では翌日の 05:00。
    assert.equal(stamp(new Date('2026-09-07T20:00:00Z')), '20260908-0500');
    assert.match(stamp(), /^\d{8}-\d{4}$/);
  });

  test('**どこへ置いたかを、絶対パスで言う**', async () => {
    const dir = await tempDir('aas-report-say-');
    const saved = await saveReport('doctor', 'x', [dir]);
    const said = tellWhereItWent(saved).join('\n');
    assert.ok(said.includes(saved.path!), `置いた先を言っていない: ${said}`);
    assert.match(said, /そのまま送って/, '次の一手を言っていない');
  });

  test('置けなかったときも、次の一手を言う（対）', () => {
    const said = tellWhereItWent({ why: '書けません' }).join('\n');
    assert.match(said, /書けません/, '理由を落としている');
    assert.match(said, /そのまま送って/, '次の一手を言っていない');
  });
});
