/**
 * ハーネス計測の検証。
 * 「良い規則」と「邪魔な規則」を数字で見分けられることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { HarnessMetrics, formatReport } from '../src/harness/metrics.ts';

const RULES = ['good-rule', 'strict-rule', 'sleeping-rule'];

function withHistory(): HarnessMetrics {
  const m = new HarnessMetrics();
  // 誘導できている規則: 拒否した後、作業は完了している
  for (let i = 0; i < 5; i += 1) {
    m.beginTask();
    m.recordDenial('good-rule');
    m.endTask('completed');
  }
  // 邪魔をしている規則: 拒否した後、作業が壊れている
  for (let i = 0; i < 5; i += 1) {
    m.beginTask();
    m.recordDenial('strict-rule');
    m.endTask('failed');
  }
  return m;
}

describe('ハーネス計測', () => {
  test('誘導できている規則を良好と判定する', () => {
    const r = withHistory().report(RULES);
    const good = r.rules.find((x) => x.rule === 'good-rule')!;
    assert.equal(good.verdict, 'good');
    assert.equal(good.recoveryRate, 1);
  });

  test('作業を壊している規則を過剰の疑いと判定する', () => {
    const r = withHistory().report(RULES);
    const strict = r.rules.find((x) => x.rule === 'strict-rule')!;
    assert.equal(strict.verdict, 'suspect');
    assert.equal(strict.recoveryRate, 0);
    assert.ok(r.advice.some((a) => a.includes('strict-rule')));
  });

  test('一度も発動しない規則を未発動として挙げる', () => {
    const r = withHistory().report(RULES);
    const sleeping = r.rules.find((x) => x.rule === 'sleeping-rule')!;
    assert.equal(sleeping.verdict, 'unused');
    assert.equal(sleeping.denials, 0);
  });

  test('試行が少ないうちは判断を保留する', () => {
    const m = new HarnessMetrics();
    m.beginTask();
    m.recordDenial('new-rule');
    m.endTask('failed');
    const r = m.report(['new-rule']);
    assert.equal(r.rules[0]!.verdict, 'unknown', '1件で決めつけている');
  });

  test('同じ規則が1つの依頼で何度拒否しても、依頼としては1件', () => {
    const m = new HarnessMetrics();
    m.beginTask();
    m.recordDenial('r');
    m.recordDenial('r');
    m.recordDenial('r');
    m.endTask('completed');
    const stat = m.report(['r']).rules[0]!;
    assert.equal(stat.denials, 3);
    assert.equal(stat.recovered, 1);
  });

  test('拒否なしで完了した割合を出す', () => {
    const m = new HarnessMetrics();
    m.beginTask(); m.endTask('completed');
    m.beginTask(); m.endTask('completed');
    m.beginTask(); m.recordDenial('r'); m.endTask('completed');
    assert.equal(m.report(['r']).cleanTaskRatio, 2 / 3);
  });

  test('拒否が多すぎればハーネス全体を疑うよう促す', () => {
    const m = new HarnessMetrics();
    for (let i = 0; i < 10; i += 1) {
      m.beginTask();
      m.recordDenial('r');
      m.endTask('completed');
    }
    const r = m.report(['r']);
    assert.ok(r.advice.some((a) => a.includes('邪魔をしている疑い')),
      `ハーネス過剰の警告が出ていない: ${r.advice.join(' / ')}`);
  });

  test('記録を保存して読み直せる', async () => {
    const dir = await tempDir('aas-hm-');
    const path = join(dir, 'harness.json');

    const m = new HarnessMetrics(path);
    m.beginTask(); m.recordDenial('r'); m.endTask('completed');
    await m.save();

    const reloaded = new HarnessMetrics(path);
    await reloaded.load();
    const stat = reloaded.report(['r']).rules[0]!;
    assert.equal(stat.denials, 1);
    assert.equal(stat.recovered, 1);
    assert.equal(reloaded.report(['r']).tasks, 1);
  });

  test('重なって走る依頼の拒否は、札ごとに分けて結末に結び付ける', () => {
    const m = new HarnessMetrics();
    m.beginTask('a');
    m.beginTask('b');
    m.recordDenial('r', 'a');
    // b の始まりと終わりで、走っている a の拒否を消さない。
    m.endTask('completed', 'b');
    m.endTask('failed', 'a');
    const stat = m.report(['r']).rules[0]!;
    assert.equal(stat.denials, 1);
    assert.equal(stat.recovered, 0, 'b の完了を a の拒否に結び付けた');
    assert.equal(stat.abandoned, 1, 'a の失敗を拒否に結び付けていない');
    assert.equal(m.report(['r']).tasks, 2);
    assert.equal(m.report(['r']).cleanTaskRatio, 0.5, 'b は拒否の無い依頼');
  });

  test('札を渡さない呼び方は、これまでどおり一つの依頼を追う', () => {
    const m = new HarnessMetrics();
    m.beginTask(); m.recordDenial('r'); m.endTask('completed');
    // 終えた札は閉じる。次の依頼に前の拒否を持ち越さない。
    m.beginTask(); m.endTask('failed');
    const stat = m.report(['r']).rules[0]!;
    assert.equal(stat.recovered, 1);
    assert.equal(stat.abandoned, 0, '前の依頼の拒否を次の依頼に持ち越した');
  });

  test('記録が無くても落ちない', async () => {
    const m = new HarnessMetrics('/nonexistent/x.json');
    await m.load();
    assert.equal(m.report([]).tasks, 0);
  });

  test('人が読める表になる', () => {
    const text = formatReport(withHistory().report(RULES));
    assert.match(text, /good-rule/);
    assert.match(text, /過剰の疑い/);
    assert.match(text, /未発動/);
  });
});
