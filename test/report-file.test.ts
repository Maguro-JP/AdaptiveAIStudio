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

  /**
   * 出す仕組みだけ在って、減らす仕組みが無かった。押すたびに一つ増え、
   * 作業場に doctor-20260912-1126.txt が 37 個並んだ（実機）。
   */
  test('**古い記録は、新しい方から残して片づける**', async () => {
    const { readdir } = await import('node:fs/promises');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-report-keep-');
    // 15 個、古い順に置く（名前の順が時刻の順）。
    for (let i = 1; i <= 15; i += 1) {
      await writeFile(join(dir, `doctor-20260901-${String(1000 + i)}.txt`), 'x');
    }
    // よその記録と、形の違うものは触らない。
    await writeFile(join(dir, 'test-20260101-0000.txt'), 'x');
    await writeFile(join(dir, 'doctor.txt'), 'x');
    await writeFile(join(dir, 'メモ.txt'), 'x');

    const saved = await saveReport('doctor', 'いま出したもの', [dir]);
    assert.ok(saved.path, saved.why);

    const left = (await readdir(dir)).sort();
    const doctors = left.filter((f) => /^doctor-\d{8}-\d{4}\.txt$/.test(f));
    assert.equal(doctors.length, 10, `残した数が違う: ${doctors.join(', ')}`);
    // いま出したものは必ず残る。
    assert.ok(doctors.includes(saved.path!.split(/[\\/]/).at(-1)!), '出した当のものを消している');
    // いちばん古いものから消える。
    assert.ok(!doctors.includes('doctor-20260901-1001.txt'), '古い方を残している');
    // **よそのものには触らない。**
    assert.ok(left.includes('test-20260101-0000.txt'), '別の名前の記録を消した');
    assert.ok(left.includes('doctor.txt'), '形の違うものを消した');
    assert.ok(left.includes('メモ.txt'), '関係ないファイルを消した');

    // **消した数は必ず言う。**黙って消さない。
    assert.equal(saved.removed, 6);
    assert.match(tellWhereItWent(saved).join('\n'), /古い 6 件は片づけました/);
  });

  test('**残す数より少なければ、何も消さない（対）**', async () => {
    const { readdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-report-few-');
    await writeFile(join(dir, 'doctor-20260901-1001.txt'), 'x');
    const saved = await saveReport('doctor', 'x', [dir]);
    assert.equal(saved.removed, undefined, '消していないのに消したと言っている');
    assert.equal((await readdir(dir)).length, 2);
    assert.ok(!tellWhereItWent(saved).join('\n').includes('片づけました'));
  });
});
