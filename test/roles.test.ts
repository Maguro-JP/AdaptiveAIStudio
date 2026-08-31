/**
 * 役職の検証。
 * 気質が指示に反映され、権限がツールの割り当てで守られることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RoleRegistry, toolsFor } from '../src/roles/registry.ts';
import { buildSystemPrompt } from '../src/roles/role.ts';
import { BUILTIN_ROLES, tester, breaker, security } from '../src/roles/builtin.ts';
import type { Tool } from '../src/agent/tools/types.ts';

const fakeTool = (name: string): Tool => ({
  schema: { name, description: '', parameters: {} },
  async run() { return { content: '' }; },
});

const pool = {
  read: [fakeTool('read_file'), fakeTool('search_text')],
  write: [fakeTool('write_file')],
  execute: [fakeTool('run_command')],
};

describe('役職の定義', () => {
  test('組み込みの役職が揃っている', () => {
    const r = new RoleRegistry();
    for (const id of ['worker', 'tester', 'breaker', 'security', 'reviewer',
                      'planner', 'reporter', 'scout', 'librarian', 'envoy']) {
      assert.ok(r.get(id), `${id} が登録されていない`);
    }
  });

  test('検査担当と破壊担当は気質が正反対', () => {
    assert.match(tester.disposition, /几帳面/);
    assert.match(breaker.disposition, /意地が悪い/);
    // 同じ検査でも、見るものが違う
    assert.ok(tester.instructions.some((i) => i.includes('正しい使い方')));
    assert.ok(breaker.instructions.some((i) => i.includes('境界')));
  });

  test('気質が指示として具体化されている', () => {
    // 「丁寧に」のような抽象語だけで終わっていないこと
    for (const role of BUILTIN_ROLES) {
      assert.ok(role.instructions.length >= 3,
        `${role.id} の指示が少なすぎる（気質が行動に落ちていない）`);
      assert.ok(role.disposition.length > 20, `${role.id} の気質が薄い`);
    }
  });
});

describe('呼び名', () => {
  test('全員に英名がある', () => {
    for (const r of BUILTIN_ROLES) {
      assert.match(r.codename, /^[A-Z][A-Z-]+$/, `${r.id} の英名が無い`);
    }
  });

  test('英名は重複しない', () => {
    const names = BUILTIN_ROLES.map((r) => r.codename);
    assert.equal(new Set(names).size, names.length);
  });

  test('システムプロンプトで英名を名乗る', () => {
    assert.match(buildSystemPrompt(breaker), /GREMLIN/);
  });

  test('追加した役職にも英名が付く', () => {
    const r = new RoleRegistry([{
      id: 'perf', name: '性能担当', responsibility: 'x', disposition: 'y',
      access: ['read'], instructions: ['a', 'b', 'c'],
    }]);
    assert.equal(r.get('perf')!.codename, 'PERF');
  });
});

describe('情報担当', () => {
  test('外を見る ENVOY と、手元を見る SCOUT を分けている', () => {
    const r = new RoleRegistry();
    const envoy = r.get('envoy')!;
    const scout = r.get('scout')!;
    assert.match(envoy.responsibility, /外の世界/);
    assert.match(scout.responsibility, /手元にない/);
  });

  test('関係の無い情報を持ち帰らないことを明記している', () => {
    const envoy = new RoleRegistry().get('envoy')!;
    assert.ok(envoy.instructions.some((i) => i.includes('関係が言えないなら持ち帰らない')));
  });

  test('出典を求めている', () => {
    const envoy = new RoleRegistry().get('envoy')!;
    assert.match(envoy.disposition, /出典/);
  });
});

describe('権限', () => {
  test('書き込みを持つのは作業担当と整理担当だけ', () => {
    const writers = BUILTIN_ROLES.filter((r) => r.access.includes('write')).map((r) => r.id);
    assert.deepEqual(writers.sort(), ['librarian', 'worker']);
  });

  test('安全担当は読むだけ', () => {
    assert.deepEqual(security.access, ['read']);
    const tools = toolsFor(security, pool).map((t) => t.schema.name);
    assert.deepEqual(tools.sort(), ['read_file', 'search_text']);
  });

  test('破壊担当は実行できるが書き込めない', () => {
    const tools = toolsFor(breaker, pool).map((t) => t.schema.name);
    assert.ok(tools.includes('run_command'), '壊し方を試せない');
    assert.equal(tools.includes('write_file'), false, '破壊担当に書き込みを渡している');
  });

  test('作業担当は全部持つ', () => {
    const worker = new RoleRegistry().get('worker')!;
    assert.equal(toolsFor(worker, pool).length, 4);
  });
});

describe('システムプロンプト', () => {
  test('責務・姿勢・進め方が含まれる', () => {
    const text = buildSystemPrompt(breaker);
    assert.match(text, /破壊担当/);
    assert.match(text, /意地が悪い/);
    assert.match(text, /境界を攻める/);
  });

  test('書き込み権限が無いことを明記する', () => {
    assert.match(buildSystemPrompt(security), /書き込みツールは渡されていません/);
    assert.doesNotMatch(buildSystemPrompt(new RoleRegistry().get('worker')!),
      /書き込みツールは渡されていません/);
  });

  test('出力形式が指定されていれば含める', () => {
    assert.match(buildSystemPrompt(tester), /PROPOSAL/);
  });
});

describe('人員の追加', () => {
  test('設定から新しい役職を足せる', () => {
    const r = new RoleRegistry([{
      id: 'perf',
      name: '性能担当',
      responsibility: '遅いところを探す',
      disposition: '体感より計測を信じる。推測で最適化しない。',
      access: ['read', 'execute'],
      instructions: ['計測する', '一番遅いところから見る', '効果を数字で示す'],
    }]);
    assert.ok(r.get('perf'));
    assert.match(buildSystemPrompt(r.get('perf')!), /計測を信じる/);
  });

  test('既存の役職を土台に、気質だけ変えられる', () => {
    const r = new RoleRegistry([{
      id: 'gentle-breaker',
      extends: 'breaker',
      name: '穏当な破壊担当',
      disposition: '意地悪だが、現実に起こりうる範囲に留める。',
    }]);
    const role = r.get('gentle-breaker')!;
    assert.match(role.disposition, /現実に起こりうる/);
    // 土台の指示と権限は引き継ぐ
    assert.deepEqual(role.access, breaker.access);
    assert.ok(role.instructions.some((i) => i.includes('境界')));
  });

  test('既存の役職を上書きできる', () => {
    const r = new RoleRegistry([{ id: 'tester', disposition: '違う気質' }]);
    assert.equal(r.get('tester')!.disposition, '違う気質');
    assert.equal(r.get('tester')!.name, '検査担当', '名前まで消えている');
  });

  test('項目が足りない役職は登録しない', () => {
    const r = new RoleRegistry([{ id: 'broken', name: '名前だけ' }]);
    assert.equal(r.get('broken'), undefined, '中途半端な役職を登録している');
  });
});

/**
 * 整備担当（QUARTERMASTER）。
 *
 * 情報担当（ENVOY）と分けてある。あちらは利用者の仕事に関する外の情報、
 * こちらは道具の側の話。混ぜると、利用者に必要な報告が
 * 道具の都合に押し出される。分かれていることを検査で固定する。
 */
describe('整備担当と情報担当の持ち場', () => {
  test('別の役職として存在する', () => {
    const roles = new RoleRegistry(BUILTIN_ROLES);
    const q = roles.get('quartermaster');
    const e = roles.get('envoy');
    assert.ok(q, '整備担当がいない');
    assert.ok(e, '情報担当がいない');
    assert.notEqual(q.id, e.id);
  });

  test('整備担当は外へ出られるが、書き込みは持たない', () => {
    // 出口を一つに絞る作りはやめた（経由させるぶん遅く、情報も落ちるため）。
    // 守るのは「外から来たものが、そのまま書き込みに化けないこと」。
    const q = new RoleRegistry(BUILTIN_ROLES).get('quartermaster')!;
    assert.ok(q.access.includes('network'), '配布元を自分で確かめられない');
    assert.ok(!q.access.includes('write'), '外に出て書ける役職になっている');
  });

  test('整備担当は利用者のコードに立ち入らない', () => {
    const q = new RoleRegistry(BUILTIN_ROLES).get('quartermaster')!;
    assert.match(q.disposition + q.instructions.join(''), /持ち場/);
  });

  test('新しさだけで勧めないことが、気質に書かれている', () => {
    const q = new RoleRegistry(BUILTIN_ROLES).get('quartermaster')!;
    assert.match(q.disposition, /新しさだけで勧めない/);
    assert.match(q.instructions.join(' '), /動かない/);
  });
});
