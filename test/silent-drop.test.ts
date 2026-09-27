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

  test('**読めずに退けた記憶の行の数を、画面へ渡す**（黙ると、手で直した行が効いていないことに気づけない）', async () => {
    const { collectState } = await import('../src/ui/state.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const { Memory } = await import('../src/memory/memory.ts');
    const dir = await tempDir('aas-drop-mem-');
    await mkdir(join(dir, 'state'), { recursive: true });
    const path = join(dir, 'state', 'memory.jsonl');
    const mem = new Memory(path);
    await mem.load();
    mem.seedLessons();
    await mem.save();
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = join(dir, 'state');
    try {
      const clean = await collectState(DEFAULT_CONFIG);
      assert.ok(clean.memorySize > 0, '正しい行を読めていない');
      assert.equal(clean.memorySkipped, 0);
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, '{"id":"m999","壊れた\n{"id":"m1000","kind":1}\n');
      const st = await collectState(DEFAULT_CONFIG);
      assert.equal(st.memorySkipped, 2, '退けた行の数を出していない');
      assert.equal(st.memorySize, clean.memorySize);
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

  test('**落とした数は、読み直しても残る（次の保存で消さない）**', async () => {
    // 保存に残すところまでは直していたが、**読む側が見ていなかった。**
    // 立ち上げ直すと 0 に戻り、次の保存でその 0 を書き込むので、
    // 残していた数まで消える。往復で見る。
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const { readFile } = await import('node:fs/promises');
    const dir = await tempDir('aas-drop-round-');
    const path = join(dir, 'proposals.json');
    const first = new ProposalQueue(path);
    for (let i = 0; i < MAX_ITEMS + 30; i += 1) {
      first.add({ title: `提案${i}`, rationale: 'そう見えた', evidence: [], suggestedAction: '直す', kind: 'bug', fingerprint: `f${i}` });
    }
    const dropped = first.dropped;
    assert.ok(dropped > 0, `落としていない: ${dropped}`);
    await first.save();

    // 立ち上げ直したのと同じ形。
    const again = new ProposalQueue(path);
    await again.load();
    assert.equal(again.dropped, dropped, '読み直しで落とした数が消えている');

    // そのまま保存しても、消さない。
    await again.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { dropped?: number };
    assert.equal(saved.dropped, dropped, '次の保存で上書きして消している');
  });

  test('落とした数は、画面まで届く', async () => {
    // 数えて・保存して・読み直しても、出す道が無ければ人には見えない。
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const dir = await tempDir('aas-drop-ui-');
    const state = join(dir, 'state');
    await mkdir(state, { recursive: true });
    const q = new ProposalQueue(join(state, 'proposals.json'));
    for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
      q.add({ title: `提案${i}`, rationale: 'r', evidence: [], suggestedAction: 'a', kind: 'bug', fingerprint: `g${i}` });
    }
    await q.save();
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = state;
    const server = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, agent: { root: dir } } as never });
    try {
      const base = (await server.start()).replace(/\/$/, '');
      const r = await fetch(`${base}/api/proposals`);
      assert.equal(r.status, 200);
      const j = await r.json() as { dropped?: number };
      assert.equal(j.dropped, q.dropped, '落とした数を画面へ出していない');
    } finally {
      await server.stop();
      if (prev === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev;
    }
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

/**
 * やり残しを諦めたことを、黙らない。
 *
 * 上限（50 件）を超えると古い方から諦めて閉じる。閉じること自体はよいが、
 * **それが誰にも見えないと、頼んだことが黙って消えたようにしか見えない。**
 * 何回試しても終わらなくて諦めたときは言っていたのに、溜まりすぎて
 * 閉じたときは何も言っていなかった。
 */
describe('やり残しを諦めたら、そう言う', () => {
  test('溜まりすぎて閉じた分を、取り出せる', async () => {
    const { UnfinishedWork, MAX_OPEN } = await import('../src/core/unfinished.ts');
    const dir = await tempDir('aas-unfin-');
    const u = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    for (let i = 0; i < MAX_OPEN; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'maxTurns', note: '途中で切れました' });
    }
    assert.deepEqual(u.takeDropped(), [], 'まだ閉じていないのに閉じたと言っている');

    await u.add({ request: 'あふれる分', why: 'maxTurns', note: '途中で切れました' });
    const dropped = u.takeDropped();
    assert.equal(dropped.length, 1, `閉じた分を出していない: ${dropped.length}`);
    assert.equal(dropped[0]?.request, 'やり残し0', '古い方から閉じていない');
    assert.equal((await u.list()).length, MAX_OPEN, '上限を守っていない');
  });

  test('取り出したら、二度は出さない', async () => {
    const { UnfinishedWork, MAX_OPEN } = await import('../src/core/unfinished.ts');
    const dir = await tempDir('aas-unfin2-');
    const u = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    for (let i = 0; i < MAX_OPEN + 1; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'maxTurns', note: 'x' });
    }
    assert.equal(u.takeDropped().length, 1);
    assert.deepEqual(u.takeDropped(), [], '同じものを二度出している');
  });
});

/**
 * やり残しの名前が、ぶつからない。
 *
 * 時刻＋乱数2桁で作っていた。**同じミリ秒に二つ作ると、かなりの割合で
 * ぶつかる**（50 件なら 6 割）。一覧は名前で引くので、ぶつかると
 * **後のものが前のものを置き換える＝頼んだことが黙って消える。**
 *
 * 検査が時々落ちて気づいた。会話の名前で直したのと同じ不具合。
 */
describe('やり残しの名前は、ぶつからない', () => {
  test('**同じミリ秒・同じ乱数でも、必ず別の名前になる**', async () => {
    // 乱数まかせで試すと、ぶつかるかどうかが運になる（40 件で 45%）。
    // **必ずぶつかる乱数**（いつも同じ値）を渡して、それでも別になることを見る。
    const { nextId } = await import('../src/core/unfinished.ts');
    const at = 1_700_000_000_000;
    const ids = Array.from({ length: 200 }, () => nextId(at, () => 0.5));
    assert.equal(new Set(ids).size, ids.length, '同じ名前を配っている');
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i]! > ids[i - 1]!, `順が戻った: ${ids[i - 1]} → ${ids[i]}`);
    }
  });

  test('同じミリ秒に続けて控えても、全部残る', async () => {
    const { UnfinishedWork } = await import('../src/core/unfinished.ts');
    const dir = await tempDir('aas-unfin-id-');
    const u = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    const at = 1_700_000_000_000;
    for (let i = 0; i < 40; i += 1) {
      await u.add({ request: `やり残し${i}`, why: 'maxTurns', note: 'x' }, at);
    }
    const list = await u.list();
    assert.equal(list.length, 40, `消えている: ${list.length}/40`);
    assert.equal(new Set(list.map((x) => x.id)).size, 40, '同じ名前を配っている');
  });

  test('名前は、後から作った方が後ろに並ぶ', async () => {
    const { UnfinishedWork } = await import('../src/core/unfinished.ts');
    const dir = await tempDir('aas-unfin-order-');
    const u = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    const at = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const got = await u.add({ request: `やり残し${i}`, why: 'maxTurns', note: 'x' }, at);
      if (got) ids.push(got.id);
    }
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i]! > ids[i - 1]!, `順が戻った: ${ids[i - 1]} → ${ids[i]}`);
    }
  });
});

describe('提案の名前', () => {
  const seed = (n: number) => ({
    kind: 'cleanup' as const,
    title: `思いつき ${n}`,
    rationale: 'r',
    evidence: [],
    suggestedAction: 'a',
    fingerprint: `f${n}`,
  });

  /**
   * 番号を「件数 + 1」で配っていた。上限で刈ると件数が減るので、
   * **一度配った番号をもう一度配る**。実測で 200 件のうち 49 件が同じ名前
   * （p201 が繰り返し出る）。同じ名前があると、採用も却下も、
   * 狙った提案とは別のものに当たる。
   */
  test('**刈った後も、同じ名前を配らない**', async () => {
    const { ProposalQueue } = await import('../src/agent/proposals.ts');
    const box = new ProposalQueue();
    for (let i = 0; i < 300; i += 1) box.add(seed(i));
    const ids = box.all().map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `同じ名前を配っている: ${ids.length - new Set(ids).size} 件`);
  });

  test('採用や却下が、別の提案に当たらない', async () => {
    const { ProposalQueue } = await import('../src/agent/proposals.ts');
    const box = new ProposalQueue();
    for (let i = 0; i < 300; i += 1) box.add(seed(i));
    const target = box.all()[box.all().length - 1]!;
    box.setStatus(target.id, 'accepted');
    const accepted = box.all().filter((x) => x.status === 'accepted');
    assert.equal(accepted.length, 1, `一つ選んだのに ${accepted.length} 件が動いた`);
    assert.equal(accepted[0]!.title, target.title);
  });

  test('読み込んだ後も、番号が続く', async () => {
    const { ProposalQueue } = await import('../src/agent/proposals.ts');
    const dir = await tempDir('aas-prop-id-');
    const path = join(dir, 'proposals.json');
    // 刈った後の姿。番号が飛んでいて、件数と最大の番号が食い違う。
    await writeFile(path, JSON.stringify({
      items: [
        { ...seed(1), id: 'p001', status: 'open', createdAt: '2026-01-01T00:00:00.000Z' },
        { ...seed(9), id: 'p009', status: 'open', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      examined: [],
    }), 'utf8');

    const box = new ProposalQueue(path);
    await box.load();
    const added = box.add(seed(42));
    assert.ok(added);
    assert.equal(added.id, 'p010', `番号が戻っている: ${added.id}`);
  });
});
