import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  judge, accept, formatReport, changedBetween,
  type AcceptanceInput, type MemberReport,
} from '../src/agent/acceptance.ts';

const member = (over: Partial<MemberReport> = {}): MemberReport => ({
  id: 't1', roleId: 'worker', state: 'done', ms: 100, report: 'やりました', ...over,
});

const input = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  request: '設定に検証を足す',
  summary: '検証を足す',
  members: [member()],
  changed: ['src/config.ts'],
  declared: ['src/config.ts'],
  verified: 'passed',
  ...over,
});

describe('検収の判断', () => {
  test('全部通っていれば指摘無しで受け取る', () => {
    const r = judge(input());
    assert.equal(r.verdict, 'accepted');
    assert.deepEqual(r.concerns, []);
  });

  test('失敗した件があれば受け取れない', () => {
    const r = judge(input({ members: [member({ state: 'failed', error: '落ちた' })] }));
    assert.equal(r.verdict, 'rejected');
    assert.ok(r.concerns.some((c) => c.severity === 'block'));
  });

  test('検査に落ちていれば受け取れない', () => {
    const r = judge(input({ verified: 'failed', verifyDetail: '3 failed' }));
    assert.equal(r.verdict, 'rejected');
  });

  test('未実施は見落としやすいので必ず挙げる', () => {
    const r = judge(input({
      members: [member(), member({ id: 't2', state: 'skipped', error: '依存が失敗' })],
    }));
    assert.ok(r.concerns.some((c) => c.reason.includes('実施されていません')));
    assert.equal(r.verdict, 'needsHuman');
  });

  test('計画に無いファイルを触っていたら挙げる', () => {
    const r = judge(input({ changed: ['src/config.ts', 'src/secret.ts'] }));
    const c = r.concerns.find((x) => x.reason.includes('計画に無い'));
    assert.ok(c);
    assert.deepEqual(c!.where, ['src/secret.ts']);
    assert.equal(r.verdict, 'needsHuman');
  });

  test('宣言が無いときは計画外を問わない（判断材料が無いため）', () => {
    const r = judge(input({ declared: [], changed: ['src/a.ts'] }));
    assert.equal(r.concerns.length, 0);
  });

  test('何も変わっていないことを見逃さない', () => {
    const r = judge(input({ changed: [], declared: [] }));
    assert.ok(r.concerns.some((c) => c.reason.includes('何も変わっていません')));
  });

  test('失敗して何も変わらなかった場合、二重に責めない', () => {
    const r = judge(input({
      members: [member({ state: 'failed', error: 'x' })], changed: [], declared: [],
    }));
    assert.equal(r.concerns.filter((c) => c.reason.includes('何も変わっていません')).length, 0);
  });

  test('検査していない変更は確認扱いにする', () => {
    const r = judge(input({ verified: 'skipped' }));
    assert.equal(r.verdict, 'needsHuman');
    assert.ok(r.concerns.some((c) => c.reason.includes('検査していません')));
  });

  test('変更が無ければ、検査していないことは責めない', () => {
    const r = judge(input({ verified: 'skipped', changed: [], declared: [] }));
    assert.equal(r.concerns.filter((c) => c.reason.includes('検査していません')).length, 0);
  });

  test('元から失敗していたものは、今回のせいにしない', () => {
    const r = judge(input({ verified: 'preexisting' }));
    assert.equal(r.verdict, 'needsHuman');
    const c = r.concerns.find((x) => x.reason.includes('作業前から'));
    assert.equal(c!.severity, 'warn');
  });

  test('要対応が一つでもあれば受け取れない', () => {
    const r = judge(input({
      verified: 'failed',
      members: [member(), member({ id: 't2', state: 'skipped' })],
    }));
    assert.equal(r.verdict, 'rejected');
  });
});

describe('報告の形', () => {
  test('一枚に、依頼・作業・変更・指摘が揃う', () => {
    const r = accept(input({
      members: [member(), member({ id: 't2', roleId: 'tester', state: 'failed', error: '落ちた' })],
    }));
    const out = formatReport(r);
    assert.ok(out.includes('設定に検証を足す'));
    assert.ok(out.includes('[t1] worker'));
    assert.ok(out.includes('[t2] tester'));
    assert.ok(out.includes('src/config.ts'));
    assert.ok(out.includes('要対応'));
  });

  test('指摘が無いことも明記する', () => {
    assert.ok(formatReport(accept(input())).includes('指摘はありません'));
  });

  test('変更が多くても報告が長くなりすぎない', () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const out = formatReport(accept(input({ changed: many, declared: many })));
    assert.ok(out.includes('他 80件'));
    assert.ok(out.split('\n').length < 40);
  });

  test('報告が空でも落ちない', () => {
    const out = formatReport(accept(input({
      members: [member({ report: undefined, error: undefined, state: 'skipped' })],
    })));
    assert.ok(out.includes('[t1]'));
  });
});

describe('今回変わったもの', () => {
  test('元から汚れていたファイルは今回の変更に数えない', () => {
    assert.deepEqual(changedBetween(['a.ts'], ['a.ts', 'b.ts']), ['b.ts']);
  });

  test('並びを揃える', () => {
    assert.deepEqual(changedBetween([], ['c.ts', 'a.ts']), ['a.ts', 'c.ts']);
  });
});
