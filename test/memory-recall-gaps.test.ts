/**
 * 覚えの呼び戻しの不具合（61 回目の調査）。
 *
 * - 「二度としないこと」が件数の枠を食い、ほかの覚えが出てこなかった（12 件を超えた古い分は、どこにも出なくなった）
 * - ひらがなだけの 2 字（「ください」の「くだ」「さい」）だけで、関係の無い覚えが当たった
 * - 「前に駄目だった手」を件数で切ってから絞り、本当に駄目だった手を落とした
 * - 記憶のファイルを読めないと、パネルが「まだ何も覚えていません」と言った
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Memory } from '../src/memory/memory.ts';

describe('呼び戻し', () => {
  test('**嫌がられたことが枠を食わない**', () => {
    const m = new Memory();
    m.seedLessons();
    m.remember({ kind: 'fact', title: '設定から読む' });
    m.remember({ kind: 'fact', title: '画面から開く' });
    const got = m.recall('設定と画面を最初からやり直して', { lessons: false, limit: 2 });
    assert.equal(got.length, 2, `ほかの覚えが出ない: ${got.map((e) => e.title).join(' / ')}`);
  });

  test('**必ず混ぜる枠から押し出された古い嫌がられたことも、話題で当たれば出る**', () => {
    const m = new Memory();
    const old = m.remember({ kind: 'displeasure', title: '確かめずに完了と報告する', now: 1 }).entry;
    for (let i = 0; i < 12; i++) m.remember({ kind: 'displeasure', title: `別の地雷 ${i} 番`, now: 100 + i });
    assert.ok(!m.displeasures().some((e) => e.id === old.id), '前提: 古いものが必ず混ぜる枠の外にある');
    const got = m.recall('完了と報告する前に確かめる');
    assert.ok(got.some((e) => e.id === old.id), '話題で当たったのに出ない');
  });

  test('**ひらがなだけの重なりでは当てない**', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'テストを追加してください', outcome: 'worked' });
    assert.deepEqual(m.recall('ログを消してください', { lessons: false }), []);
    assert.equal(m.recall('テストを追加', { lessons: false }).length, 1, '漢字・カタカナの重なりでは当たる（対）');
  });

  test('**前に駄目だった手は、うまくいった手に押し出されない**', () => {
    const m = new Memory();
    for (let i = 0; i < 6; i++) m.remember({ kind: 'attempt', title: `設定の読み直し手順 ${i} 版`, outcome: 'worked' });
    m.remember({ kind: 'attempt', title: '設定を書き換える', outcome: 'failed' });
    m.remember({ kind: 'attempt', title: '設定をまとめる' });
    const got = m.failedBefore('設定の読み直し', 2);
    assert.deepEqual(got.map((e) => e.title), ['設定を書き換える'], '駄目だった手を落とした・確かめていない手を駄目だったとした');
  });
});

describe('読めない記憶', () => {
  test('**読めなかったことを言う**', async () => {
    const home = await tempDir('aas-memory-unreadable-');
    const before = process.env.AAS_HOME;
    process.env.AAS_HOME = home;
    try {
      const { stateDir } = await import('../src/core/autopilot-setup.ts');
      await mkdir(join(stateDir(), 'memory.jsonl'), { recursive: true });
      const { collectState } = await import('../src/ui/state.ts');
      const state = await collectState({ providers: [], candidates: [] } as never);
      assert.ok(state.memoryUnreadable, '読めなかったのに言っていない');
    } finally {
      if (before === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = before;
    }
  });
});
