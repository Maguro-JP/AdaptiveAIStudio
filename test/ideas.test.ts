/**
 * 発想（IDEA）の検証。
 * 語の衝突で種が作れること、磨きの検問が効くこと、提案キューに積めることを確かめる。
 * 乱数は種を固定する（同じ入力なら同じ結果になる試験だけを書く）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  combine, render, proposeIdea, ideaProposal, ideaFingerprint, ideaSignature,
  usablePolished, polishIdea, materialsFromContext,
  type IdeaLexicon, type IdeaSeed,
} from '../src/agent/ideas.ts';
import { ProposalQueue } from '../src/agent/proposals.ts';
import { BUILTIN_IDLE_MODES, MODE_ROLE } from '../src/harness/idle-modes.ts';

const miniLexicon = (domainsA: string[], domainsB: string[]): IdeaLexicon => ({
  pools: {
    concepts: [
      { term: '甲', domains: domainsA },
      { term: '乙', domains: domainsB },
    ],
    operations: [{ term: '並べ替える', domains: [] }],
    constraints: [],
    provocations: [],
    aspects: [],
    probes: [],
  },
  moods: ['静穏'],
  templates: [
    { id: 'pair', tone: 'proposal', needs: ['concept_a', 'concept_b'], text: '{concept_a}と{concept_b}を同じ仕組みで扱えないか。' },
  ],
});

describe('種の生成', () => {
  test('同じ種（seed）なら同じ種が再現できる', () => {
    const a = combine({ seed: 42, materials: ['通知'] });
    const b = combine({ seed: 42, materials: ['通知'] });
    assert.equal(a.templateId, b.templateId);
    assert.deepEqual(a.slots, b.slots);
    assert.equal(ideaSignature(a), ideaSignature(b));
  });

  test('材料があると、材料を使う文型が選ばれて材料が入る', () => {
    const seed = combine({ seed: 7, materials: ['通知', '会議'] });
    assert.ok(seed.slots['material'] === '通知' || seed.slots['material'] === '会議');
  });

  test('材料が無いと、材料の入る文型は選ばれない', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const seed = combine({ seed: n });
      assert.equal(seed.slots['material'], undefined);
    }
  });

  test('分野タグが遠い概念同士は遠さ 1、重なる概念同士は遠さ 0', () => {
    const far = combine({ lexicon: miniLexicon(['x'], ['y']), seed: 3 });
    assert.equal(far.novelty, 1);
    const near = combine({ lexicon: miniLexicon(['x'], ['x']), seed: 3 });
    assert.equal(near.novelty, 0);
  });

  test('概念の組は、同じ語同士にならない', () => {
    const seed = combine({ lexicon: miniLexicon(['x'], ['y']), seed: 9 });
    assert.notEqual(seed.slots['concept_a'], seed.slots['concept_b']);
  });
});

describe('文章化', () => {
  test('種を文型に当てはめて文章にする', () => {
    const seed = combine({ lexicon: miniLexicon(['x'], ['y']), seed: 3 });
    const text = render(seed, miniLexicon(['x'], ['y']));
    assert.match(text, /^(甲と乙|乙と甲)を同じ仕組みで扱えないか。$/);
  });

  test('対応する文型が無ければ投げる', () => {
    const seed: IdeaSeed = {
      templateId: 'ない', tone: 'proposal', slots: {}, mood: '静穏', seed: 1, terms: [], novelty: 0.5,
    };
    assert.throws(() => render(seed, miniLexicon([], [])));
  });
});

describe('磨きの検問', () => {
  const original = '通知の頻度を入れ替える。まず15分だけ試す。';

  test('素直な仕上がりは通る', () => {
    assert.equal(usablePolished('通知の頻度を入れ替えてみる。まず15分だけ試す。', original), true);
  });

  test('空は通らない', () => {
    assert.equal(usablePolished('', original), false);
    assert.equal(usablePolished('   ', original), false);
  });

  test('長すぎる仕上がりは通らない（余分な文が混ざっている）', () => {
    assert.equal(usablePolished('あ'.repeat(200), original), false);
  });

  test('タグや箇条書きの漏れは通らない', () => {
    assert.equal(usablePolished('<thinking>考え中</thinking>通知を変える。', original), false);
    assert.equal(usablePolished('- 通知を変える', original), false);
    assert.equal(usablePolished('```\n通知を変える。\n```', original), false);
  });

  test('句点が多すぎる仕上がりは通らない（説明が始まっている）', () => {
    assert.equal(usablePolished('一。二。三。四。', original), false);
  });
});

describe('磨き', () => {
  test('送り口が無ければ素の文章のまま', async () => {
    const seed = combine({ seed: 11, materials: ['通知'] });
    const text = render(seed);
    const got = await polishIdea(seed, text, undefined);
    assert.deepEqual(got, { text, source: 'engine' });
  });

  test('送り口が答えなければ素の文章に倒れる', async () => {
    const seed = combine({ seed: 11, materials: ['通知'] });
    const text = render(seed);
    const got = await polishIdea(seed, text, async () => undefined);
    assert.deepEqual(got, { text, source: 'engine' });
  });

  test('送り口が投げても素の文章に倒れる（例外を外へ出さない）', async () => {
    const seed = combine({ seed: 11, materials: ['通知'] });
    const text = render(seed);
    const got = await polishIdea(seed, text, async () => { throw new Error('落ちた'); });
    assert.deepEqual(got, { text, source: 'engine' });
  });

  test('検問に通らない仕上がりは採用せず、素の文章に倒れる', async () => {
    const seed = combine({ seed: 11, materials: ['通知'] });
    const text = render(seed);
    const got = await polishIdea(seed, text, async () => '<thinking>漏れ</thinking>別の文章。');
    assert.deepEqual(got, { text, source: 'engine' });
  });

  test('検問を通る仕上がりは採用する', async () => {
    const seed = combine({ seed: 11, materials: ['通知'] });
    const text = render(seed);
    const got = await polishIdea(seed, text, async () => '通知の見せ方を変える。まず一度だけ試す。');
    assert.deepEqual(got, { text: '通知の見せ方を変える。まず一度だけ試す。', source: 'llm' });
  });
});

describe('提案まで', () => {
  test('既出の組み合わせしか引けないときは出さない', async () => {
    const first = await proposeIdea({ seed: 21, materials: ['通知'] });
    assert.ok(first);
    const seen = new Set([ideaFingerprint(first.seed)]);
    const again = await proposeIdea({ seed: 21, materials: ['通知'], seen, redraws: 0 });
    assert.equal(again, undefined);
  });

  test('描き直せば、別の組み合わせが出る', async () => {
    const first = await proposeIdea({ seed: 21, materials: ['通知'] });
    assert.ok(first);
    const seen = new Set([ideaFingerprint(first.seed)]);
    const next = await proposeIdea({ seed: 21, materials: ['通知'], seen });
    assert.ok(next);
    assert.notEqual(ideaFingerprint(next.seed), ideaFingerprint(first.seed));
  });

  test('提案キューに積まれて、採否を決められる', async () => {
    const idea = await proposeIdea({ seed: 33, materials: ['通知'] });
    assert.ok(idea);
    const queue = new ProposalQueue();
    const added = queue.add(ideaProposal(idea, ['src/a.ts'], 'root-key'));
    assert.ok(added);
    assert.equal(added.kind, 'question');
    assert.equal(added.origin, 'idea');
    assert.ok(added.fingerprint.startsWith('idea:'));
    assert.equal(queue.open().length, 1);
    // 同じ提案は二重に入らない
    assert.equal(queue.add(ideaProposal(idea, ['src/a.ts'], 'root-key')), undefined);
    const settled = await queue.settle(added.id, 'accepted', { onlyOpen: true });
    assert.equal(settled?.status, 'accepted');
    assert.equal(queue.open().length, 0);
  });
});

describe('材料集め', () => {
  test('ファイルは名前だけにし、重なりを除き、長い題は入れない', () => {
    const got = materialsFromContext({
      changedFiles: ['src/core/session.ts', 'src/agent/ideas.ts'],
      recentFiles: ['src/core/session.ts', 'README.md'],
      memoryTitles: ['短い題', 'これは材料にするには長すぎる題の文章です、衝突にならない'],
    });
    assert.deepEqual(got, ['短い題', 'session', 'ideas', 'README']);
  });
});

describe('思考への登録', () => {
  test('発想が時間きっかけの思考として入っている', () => {
    const mode = BUILTIN_IDLE_MODES.find((m) => m.id === 'idea');
    assert.ok(mode);
    assert.equal(mode.codename, 'IDEA');
    assert.equal(mode.triggeredBy, 'time');
    assert.ok(MODE_ROLE['idea']);
  });
});
