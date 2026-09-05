/**
 * 落としたことを、黙らない。
 *
 * 索引が上限で切っているのを黙っていた所から始めて、同じ形を一つずつ見た。
 * **数えているのに、どこにも出していない**のが二つあった。
 *
 * 忘れたことが誰にも見えないと、「前に言ったのに覚えていない」が起きたときに、
 * **忘れたのか、思い出せないのか**を切り分けられない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

describe('溜まりものを落としたら、そう言う', () => {
  test('提案の記録は、書いた形のまま読める', async () => {
    // 保存は {items, examined, dropped}。配列として読んでいたので、
    // 画面へ渡していたのは「配列ではない何か」だった。
    const { collectState } = await import('../src/ui/state.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const dir = await tempDir('aas-drop-');
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'proposals.json'), JSON.stringify({
      items: [{ id: 'a', title: 'ひとつめ' }, { id: 'b', title: 'ふたつめ' }],
      examined: [],
      dropped: 7,
    }));
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = join(dir, 'state');
    try {
      const st = await collectState(DEFAULT_CONFIG);
      assert.equal(st.proposals.length, 2, `配列として読めていない: ${JSON.stringify(st.proposals)}`);
      assert.equal(st.proposalsDropped, 7, '落とした数を出していない');
    } finally {
      if (prev === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev;
    }
  });

  test('古い形（配列そのまま）でも読める', async () => {
    const { collectState } = await import('../src/ui/state.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const dir = await tempDir('aas-drop-old-');
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'proposals.json'), JSON.stringify([{ id: 'a' }]));
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = join(dir, 'state');
    try {
      const st = await collectState(DEFAULT_CONFIG);
      assert.equal(st.proposals.length, 1);
      assert.equal(st.proposalsDropped, 0);
    } finally {
      if (prev === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev;
    }
  });

  test('**落とした数を、保存にも残す**', async () => {
    // 数えているだけだと、立ち上げ直すと「無かったこと」になる。
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const dir = await tempDir('aas-drop-save-');
    const path = join(dir, 'proposals.json');
    const q = new ProposalQueue(path);
    for (let i = 0; i < MAX_ITEMS + 30; i += 1) {
      q.add({ title: `提案${i}`, rationale: 'そう見えた', evidence: [], suggestedAction: '直す', kind: 'bug', fingerprint: `f${i}` });
    }
    assert.ok(q.dropped > 0, `落としていない: ${q.dropped}`);
    await q.save();
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as
      { dropped?: number };
    assert.equal(saved.dropped, q.dropped, '保存に残していない');
  });

  test('記憶を刈ったら、何件片づけたかを言う', async () => {
    const { Memory } = await import('../src/memory/memory.ts');
    const m = new Memory();
    for (let i = 0; i < 60; i += 1) m.remember({ kind: 'fact', title: `事実${i}`, detail: 'x' });
    const dropped = m.compact({ max: 20 });
    assert.ok(dropped > 0, '落としていない');
    assert.equal(m.size, 20);
  });
});
