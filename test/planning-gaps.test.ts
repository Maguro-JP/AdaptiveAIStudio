/**
 * 段取りと分担の不具合（27 回目の調査）。
 *
 * - 合議で確かめられなかった担当がいるのに「全員が問題なし」と言わない
 * - 段に割るとき、決めた数を超えたら割らない。落ちた・上限で切れた返事を段にしない。見出しや結びを段にしない
 * - 計画の ID の振り直しで、依存の相手を入れ替えない。deps が文字列一つでも受ける
 * - 新しいフォルダの中の計画外のファイルを、受け入れの報告から消さない
 * - 見回りで調べ切れなかった回を「所見なし」にしない
 * - Go・Python のテストがあるファイルに「対応するテストが見当たりません」と言わない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { panelVerdict } from '../src/agent/panel.ts';
import { decompose, readSteps } from '../src/agent/decompose.ts';
import { repairPlan, type PmContext } from '../src/agent/pm.ts';
import { dropCoveredDirs } from '../src/agent/acceptance.ts';
import { findLeads, reconCutShort } from '../src/agent/initiative.ts';
import { Prefetcher } from '../src/agent/prefetch.ts';
import type { ChatOrchestrator } from '../src/core/orchestrator.ts';

describe('合議の結び', () => {
  test('**所見が無くても、落ちた担当がいれば「全員が問題なし」と言わない**', () => {
    const said = panelVerdict(0, 3);
    assert.ok(said && !said.includes('全員が問題なし'), said);
    assert.match(said!, /3 人は確かめられませんでした/);
    assert.match(panelVerdict(2, 1) ?? '', /1 人は確かめられませんでした/);
  });
  test('全員が答えて所見が無ければ「全員が問題なし」（対）', () => {
    assert.equal(panelVerdict(0, 0), '全員が問題なしと判断しました。');
    assert.equal(panelVerdict(2, 0), undefined);
  });
});

function fakeOrchestrator(events: unknown[]): ChatOrchestrator {
  return { run: async function* () { for (const e of events) yield e; } } as unknown as ChatOrchestrator;
}

describe('段に割る', () => {
  test('**決めた数より多く返ってきたら、頭だけ拾わずに割らない**', () => {
    assert.deepEqual(readSteps('src/a.ts を読む\nsrc/a.ts の型を直す\nsrc/b.ts を読む\nsrc/b.ts を直す', 3), []);
  });
  test('**途中で落ちた返事を段にしない**', async () => {
    const orch = fakeOrchestrator([
      { type: 'text', delta: 'src/a.ts の foo を読む\nsrc/a.ts の型を直す\nsrc/b.ts の bar を' },
      { type: 'failed', error: { kind: 'network', message: 'x' } },
    ]);
    assert.deepEqual(await decompose(orch, { request: '直す', candidates: [], size: 'large' } as never), []);
  });
  test('**上限で切れた返事を段にしない**', async () => {
    const orch = fakeOrchestrator([
      { type: 'text', delta: 'src/a.ts の foo を読む\nsrc/a.ts の型を直す\nsrc/b.ts の bar を' },
      { type: 'done', modelId: 'p:m', finishReason: 'length' },
    ]);
    assert.deepEqual(await decompose(orch, { request: '直す', candidates: [], size: 'large' } as never), []);
  });
  test('言い終えた返事は段にする（対）', async () => {
    const orch = fakeOrchestrator([
      { type: 'text', delta: 'src/a.ts の foo を読む\nsrc/a.ts の型を直す' },
      { type: 'done', modelId: 'p:m', finishReason: 'stop' },
    ]);
    assert.equal((await decompose(orch, { request: '直す', candidates: [], size: 'large' } as never)).length, 2);
  });
  test('**太字の見出し・記号の付いた導入・結びを段にしない**', () => {
    assert.deepEqual(
      readSteps('**手順:**\n- 以下の順で進めます\nsrc/a.ts を読む\nsrc/a.ts の型を直す\n以上です。', 6),
      ['src/a.ts を読む', 'src/a.ts の型を直す'],
    );
  });
});

describe('計画の ID', () => {
  const ctx: PmContext = {
    lanes: [{ id: 'fast', candidates: ['a'], parallel: 2 }],
    roleIds: ['worker'], fallbackRoleId: 'worker', maxItems: 8,
  };
  test('**ID の無い項目に振る ID で、後ろの項目の ID を奪わない**（C が待つのは B のまま）', () => {
    const p = repairPlan({ summary: 's', items: [
      { instruction: 'A をする' },
      { id: 't1', instruction: 'B をする' },
      { id: 't3', deps: ['t1'], instruction: 'C をする' },
    ] }, '依頼', ctx);
    const b = p.items.find((t) => t.instruction === 'B をする')!;
    const c = p.items.find((t) => t.instruction === 'C をする')!;
    assert.deepEqual(c.deps, [b.id], `C の待つ相手が入れ替わった: ${JSON.stringify(p.items)}`);
  });
  test('**deps が文字列一つでも、待つ相手として受ける**', () => {
    const p = repairPlan({ summary: 's', items: [
      { id: 't1', instruction: 'A をする' },
      { id: 't2', deps: 't1', instruction: 'B をする' },
    ] }, '依頼', ctx);
    assert.deepEqual(p.items.find((t) => t.id === 't2')!.deps, ['t1']);
  });
});

describe('新しいフォルダ', () => {
  test('**書いたファイルの外にも、そのフォルダの下で変わったものがあれば、フォルダを外さない**', () => {
    assert.deepEqual(dropCoveredDirs(['sub/'], ['sub/a.ts'], ['sub/b.ts', 'sub/c.ts']), ['sub/']);
  });
  test('書いたファイルだけなら、今までどおり外す（対）', () => {
    assert.deepEqual(dropCoveredDirs(['sub/'], ['sub/a.ts'], ['sub/a.ts']), []);
    assert.deepEqual(dropCoveredDirs(['sub/'], ['sub/a.ts']), []);
  });
});

describe('見回りの終わり方', () => {
  test('**ターンの上限・堂々巡り・上限で切れた回は、調べ切っていない**', () => {
    assert.ok(reconCutShort('maxTurns'));
    assert.ok(reconCutShort('noProgress'));
  });
  test('言い終えた回は、調べ切った（対）', () => {
    assert.equal(reconCutShort('completed'), undefined);
  });
});

describe('テストの対応', () => {
  test('**Go の a_test.go・Python の test_a.py があれば、対応するテストが無いと言わない**', async () => {
    const root = await tempDir('aas-plan-gaps-');
    const files: Record<string, string> = {
      'pkg/a.go': 'package pkg\nfunc A() int { return 1 }\n',
      'pkg/a_test.go': 'package pkg\nimport "testing"\nfunc TestA(t *testing.T) {}\n',
      'lib/b.py': 'def b():\n    return 1\n',
      'tests/test_b.py': 'def test_b():\n    assert True\n',
    };
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true });
      await writeFile(join(root, name), body);
    }
    const p = new Prefetcher(root, undefined, () => true);
    p.start();
    const leads = await findLeads({ root, snapshot: (await p.snapshot())!, known: new Set(), max: 20 });
    const missing = leads.filter((l) => /対応するテストが見当たりません/.test(l.title)).map((l) => l.title);
    assert.deepEqual(missing, [], missing.join(' / '));
  });
});
