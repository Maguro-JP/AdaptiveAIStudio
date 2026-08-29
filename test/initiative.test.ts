/**
 * 自発性の検証。
 * 事実から手がかりを見つけ、提案として溜められることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLeads, investigationPrompt, parseProposal } from '../src/agent/initiative.ts';
import { ProposalQueue, formatProposal } from '../src/agent/proposals.ts';
import { Prefetcher } from '../src/agent/prefetch.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aas-init-'));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

async function snapshotOf(root: string) {
  const p = new Prefetcher(root);
  p.start();
  return (await p.snapshot())!;
}

async function leadsOf(root: string, known = new Set<string>()) {
  return findLeads({ root, snapshot: await snapshotOf(root), known, max: 20 });
}

describe('手がかりの発見', () => {
  test('握り潰された例外を見つける', async () => {
    const root = await project({
      'src/a.ts': 'try { risky(); } catch {}\nexport const x = 1;',
      'src/a.test.ts': 'test("x",()=>{});',
    });
    const leads = await leadsOf(root);
    const hit = leads.find((l) => l.kind === 'bug');
    assert.ok(hit, `空のcatchを見つけていない: ${leads.map((l) => l.title).join(' / ')}`);
    assert.match(hit.title, /catch/);
  });

  test('未処理の印を見つける', async () => {
    const root = await project({
      'src/a.ts': '// TODO: 認証を実装する\nexport const x = 1;',
      'src/a.test.ts': 'test("x",()=>{});',
    });
    const hit = (await leadsOf(root)).find((l) => l.kind === 'risk');
    assert.ok(hit);
    assert.match(hit.fact, /認証を実装/);
  });

  test('テストが無い実装を見つける', async () => {
    const root = await project({ 'src/untested.ts': 'export const x = 1;' });
    const hit = (await leadsOf(root)).find((l) => l.kind === 'test');
    assert.ok(hit);
    assert.match(hit.title, /untested\.ts/);
  });

  test('テストがある実装は挙げない', async () => {
    const root = await project({
      'src/covered.ts': 'export const x = 1;',
      'test/covered.test.ts': 'test("x",()=>{});',
    });
    const leads = await leadsOf(root);
    assert.equal(leads.some((l) => l.kind === 'test' && l.title.includes('covered.ts')), false);
  });

  test('大きすぎるファイルを見つける', async () => {
    const root = await project({
      'src/big.ts': Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join('\n'),
      'src/big.test.ts': 'test("x",()=>{});',
    });
    const hit = (await leadsOf(root)).find((l) => l.kind === 'cleanup');
    assert.ok(hit);
    assert.match(hit.title, /700 行/);
  });

  test('重要そうなものから順に並ぶ', async () => {
    const root = await project({
      'src/a.ts': 'try { f(); } catch {}\n// TODO: あとで\n',
      'src/a.test.ts': 'test("x",()=>{});',
    });
    const leads = await leadsOf(root);
    assert.equal(leads[0]!.kind, 'bug', '不具合の疑いが最優先になっていない');
  });

  test('既に提案済みの手がかりは出さない', async () => {
    const root = await project({ 'src/a.ts': 'try { f(); } catch {}' });
    const first = await leadsOf(root);
    const known = new Set(first.map((l) => l.fingerprint));
    const second = await leadsOf(root, known);
    assert.equal(second.length, 0, '同じ手がかりを繰り返している');
  });

  test('指紋は同じ手がかりで安定している', async () => {
    const root = await project({ 'src/a.ts': 'try { f(); } catch {}' });
    const a = await leadsOf(root);
    const b = await leadsOf(root);
    assert.deepEqual(a.map((l) => l.fingerprint), b.map((l) => l.fingerprint));
  });
});

describe('調査の依頼文', () => {
  test('確認を求め、変更を禁じている', async () => {
    const root = await project({ 'src/a.ts': 'try { f(); } catch {}' });
    const prompt = investigationPrompt((await leadsOf(root))[0]!);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /変更してはいけません/);
    assert.match(prompt, /問題なし/);
  });
});

describe('提案の取り出し', () => {
  test('形式に従った出力から取り出す', () => {
    const p = parseProposal([
      '確認しました。', '', 'PROPOSAL',
      'title: 空のcatchで例外が消えている',
      'rationale: src/a.ts の catch が空で、失敗が表に出ない',
      'action: catch でログを出すか、上位へ投げ直す',
    ].join('\n'));
    assert.equal(p?.title, '空のcatchで例外が消えている');
    assert.match(p!.action, /投げ直す/);
  });

  test('問題なしと答えたら提案にしない', () => {
    assert.equal(parseProposal('確認しましたが問題なしです。'), undefined);
  });

  test('形式が崩れていれば採用しない', () => {
    assert.equal(parseProposal('PROPOSAL\nなんとなく直した方がいい気がします'), undefined);
  });
});

describe('提案キュー', () => {
  const sample = (fingerprint: string, title = 'タイトル') => ({
    kind: 'bug' as const, title, rationale: '理由', evidence: ['src/a.ts'],
    suggestedAction: 'やること', fingerprint,
  });

  test('追加して一覧できる', () => {
    const q = new ProposalQueue();
    const added = q.add(sample('f1'));
    assert.ok(added);
    assert.equal(q.open().length, 1);
    assert.equal(added.status, 'open');
  });

  test('同じ指紋の提案は重ねない', () => {
    const q = new ProposalQueue();
    q.add(sample('f1'));
    assert.equal(q.add(sample('f1', '言い方を変えただけ')), undefined);
    assert.equal(q.all().length, 1);
  });

  test('却下した提案は再び出せる', () => {
    const q = new ProposalQueue();
    const first = q.add(sample('f1'))!;
    q.setStatus(first.id, 'rejected');
    assert.ok(q.add(sample('f1')), '却下後に再提案できない');
  });

  test('IDの前方一致で引ける', () => {
    const q = new ProposalQueue();
    const p = q.add(sample('f1'))!;
    assert.equal(q.find(p.id.slice(0, 2))?.id, p.id);
  });

  test('保存して読み直せる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aas-pq-'));
    const path = join(dir, 'proposals.json');
    const q = new ProposalQueue(path);
    q.add(sample('f1'));
    await q.save();

    const reloaded = new ProposalQueue(path);
    await reloaded.load();
    assert.equal(reloaded.open().length, 1);
  });

  test('詳細表示に理由と根拠が出る', () => {
    const q = new ProposalQueue();
    const p = q.add(sample('f1'))!;
    const text = formatProposal(p, true);
    assert.match(text, /理由/);
    assert.match(text, /根拠/);
    assert.match(text, /やること/);
  });
});

describe('重複の防止', () => {
  const base = {
    kind: 'bug' as const, rationale: '理由', evidence: ['src/a.ts'],
    suggestedAction: 'やること',
  };

  test('別の手がかりから同じ発見が来ても重ねない', () => {
    const q = new ProposalQueue();
    q.add({ ...base, title: 'catch が空で例外が消える', fingerprint: 'lead-bug' });
    const second = q.add({
      ...base, kind: 'test',
      title: 'catch が空で例外が消える', // 同じ発見
      fingerprint: 'lead-test',          // 別の手がかり
    });
    assert.equal(second, undefined, '同じ発見が二重に積まれている');
    assert.equal(q.all().length, 1);
  });

  test('表記ゆれも同じ発見とみなす', () => {
    const q = new ProposalQueue();
    q.add({ ...base, title: 'catch が空で例外が消える', fingerprint: 'a' });
    assert.equal(
      q.add({ ...base, title: 'catchが空で、例外が消える。', fingerprint: 'b' }),
      undefined,
    );
  });

  test('違う発見はきちんと積まれる', () => {
    const q = new ProposalQueue();
    q.add({ ...base, title: 'catch が空', fingerprint: 'a' });
    assert.ok(q.add({ ...base, title: 'テストが無い', fingerprint: 'b' }));
    assert.equal(q.all().length, 2);
  });
});

describe('調べ直しの防止', () => {
  test('問題なしだった手がかりも覚えて、二度と調べない', async () => {
    const root = await project({ 'src/a.ts': 'try { f(); } catch {}' });
    const q = new ProposalQueue();
    const first = await findLeads({ root, snapshot: await snapshotOf(root), known: q.seen(), max: 5 });
    assert.ok(first.length > 0);

    // 調べたが提案にはならなかった、という記録
    for (const l of first) q.markExamined(l.fingerprint);

    const second = await findLeads({ root, snapshot: await snapshotOf(root), known: q.seen(), max: 5 });
    assert.equal(second.length, 0, '問題なしだった所を調べ直している');
  });

  test('ファイルが変われば、また調べる', async () => {
    const root = await project({ 'src/a.ts': 'try { f(); } catch {}' });
    const q = new ProposalQueue();
    const first = await findLeads({ root, snapshot: await snapshotOf(root), known: q.seen(), max: 5 });
    for (const l of first) q.markExamined(l.fingerprint);

    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(root, 'src/a.ts'), 'try { g(); h(); } catch {}\n// 変更した');

    const second = await findLeads({ root, snapshot: await snapshotOf(root), known: q.seen(), max: 5 });
    assert.ok(second.length > 0, '変更後も調べ直していない');
  });

  test('調査済みの記録も保存される', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aas-pq2-'));
    const path = join(dir, 'proposals.json');
    const q = new ProposalQueue(path);
    q.markExamined('abc123');
    await q.save();

    const reloaded = new ProposalQueue(path);
    await reloaded.load();
    assert.ok(reloaded.seen().has('abc123'));
  });
});
