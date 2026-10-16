/**
 * 溜まったものを片づける。
 *
 * **消してはいけないものを、消さないことを確かめる。**
 * GGUF は数GBある。落とし直しに何十分もかかるものを黙って消されるのが、
 * いちばん困る。「消せた」ことより「消さなかった」ことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { findRemovable } from '../src/runtime/cleanup.ts';
import { spawn } from 'node:child_process';

/** 置き場を作って、その中に一式を並べる。 */
async function scratch(): Promise<{ home: string; models: string; bin: string }> {
  const home = await tempDir('aas-clean-');
  const models = join(home, 'models');
  const bin = join(home, 'bin');
  await mkdir(models, { recursive: true });
  await mkdir(bin, { recursive: true });
  process.env.AAS_HOME = home;
  delete process.env.AAS_MODELS_DIR;
  delete process.env.AAS_BIN_DIR;
  delete process.env.AAS_STATE_DIR;
  return { home, models, bin };
}

describe('片づけるもの・片づけないもの', () => {
  test('GGUF は消さない', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
    await writeFile(join(models, 'よその.GGUF'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), [], 'モデルを消そうとしている');
  });

  test('会話の見出しの書き換えで残った古い一時ファイルは消す。書いている最中の新しいものと会話そのものは消さない', async () => {
    const { home } = await scratch();
    const talks = join(home, 'conversations');
    await mkdir(talks, { recursive: true });
    await writeFile(join(talks, 'c1.jsonl'), '{}\n');
    await writeFile(join(talks, 'c1.jsonl.123.1.tmp'), '{}\n');
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: later })).map((f) => f.path), [join(talks, 'c1.jsonl.123.1.tmp')]);
    assert.deepEqual((await findRemovable({ keepTag: 'b9999' })).map((f) => f.path), [], '書いている最中の一時ファイルを消そうとした');
  });

  test('**壊れていたので脇へ移した写しは、30 日より古いものだけ挙げる**（中身を手で拾う間は残す。似た名前は触らない）', async () => {
    const { home } = await scratch();
    const journalAside = (name: string) => `${name}.broken-2026-09-27T10-52-04-123Z`;
    // 本物の読み込みに写しを作らせる（名前の形を試験の中で決め打ちにすると、作る側と食い違っても通る）
    const { readJournal } = await import('../src/core/journal-file.ts');
    await writeFile(join(home, 'stride.json'), '{"broken"');
    assert.equal((await readJournal(join(home, 'stride.json'))).kind, 'missing');
    const made = (await readdir(home)).filter((n) => n.startsWith('stride.json.broken-')).map((n) => join(home, n));
    assert.equal(made.length, 1);
    const aside = [...made, join(home, journalAside('proposals.json'))];
    await writeFile(aside[1]!, '{"broken"');
    await writeFile(join(home, 'idle.json.broken-mine'), 'x');           // 時刻の形でない
    await writeFile(join(home, 'idle.json.broken-2026-09-27T10-52-04-123Z.txt'), 'x'); // 後ろに何か付いている
    await mkdir(join(home, journalAside('dir.json')));                  // フォルダは触らない
    const soon = Date.now() + 5 * 86_400_000;
    const later = Date.now() + 31 * 86_400_000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: soon })).map((f) => f.path).filter((p) => p.includes('.broken-')), [],
      '中身を拾う間もなく挙げた');
    const found = (await findRemovable({ keepTag: 'b9999', now: later })).filter((f) => f.path.includes('.broken-'));
    assert.deepEqual(found.map((f) => f.path).sort(), [...aside].sort());
    assert.match(found[0]!.why, /脇へ移した/);
  });

  test('**写しの古さは、移した時刻（名前の時刻）で数える**（長く書き換えていなかったファイルを、移したその日に挙げない）', async () => {
    const { home } = await scratch();
    const { utimes } = await import('node:fs/promises');
    const { readJournal } = await import('../src/core/journal-file.ts');
    const at = join(home, 'layout.json');
    await writeFile(at, '{"half');
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await utimes(at, longAgo, longAgo); // 40 日前に書いたきりの並び
    await readJournal(at); // いま壊れていると分かって、脇へ移す
    const listed = async (now: number) => (await findRemovable({ keepTag: 'b9999', now })).filter((f) => f.path.includes('layout.json.broken-'));
    assert.deepEqual(await listed(Date.now()), [], '移したその日に挙げた');
    const later = await listed(Date.now() + 31 * 86_400_000);
    assert.equal(later.length, 1);
    assert.match(later[0]!.why, /3[01]日前の写し/, later[0]!.why);
  });

  test('状態のファイルと戻り先で残った古い一時ファイルは消す。新しいもの・元のファイル・知らない名前は消さない', async () => {
    const { home } = await scratch();
    const undo = join(home, 'undo');
    await mkdir(undo, { recursive: true });
    const old = [
      join(home, 'memory.jsonl.123.a1b2c3.tmp'),
      join(home, 'unfinished.jsonl.123.4.tmp'),
      join(home, 'goals.jsonl.123.5.tmp'),
      join(undo, 'u1.json.123.6.tmp'),
      join(home, 'acks.json.123.1790000000000.k3j2h1.tmp'),
      join(home, 'harness-metrics.json.123.7.tmp'),
      join(home, 'idle.json.123.8.tmp'),
      join(home, 'duties.json.123.9.tmp'),
      join(home, 'stride.json.123.10.tmp'),
      join(home, 'metrics.json.123.11.tmp'),
      join(home, 'layout.json.123.12.tmp'),
      join(home, 'theme.json.123.13.tmp'),
      join(home, 'roles-ledger.json.123.14.tmp'),
      join(home, 'aas.config.json.123.15.tmp'),
    ];
    for (const p of old) await writeFile(p, 'x');
    await writeFile(join(home, 'memory.jsonl'), '{}\n');
    await writeFile(join(home, 'goals.jsonl'), '{}\n');
    await writeFile(join(home, 'mine.jsonl.123.4.tmp'), 'x');
    await writeFile(join(home, 'xmemory.jsonl.123.4.tmp'), 'x');
    await writeFile(join(home, 'u2.json.123.6.tmp'), 'x');     // 戻り先の一時ファイルの形でも、場所が違えば触らない
    await writeFile(join(undo, 'goals.jsonl.123.5.tmp'), 'x'); // 逆も同じ
    await writeFile(join(undo, 'u1.json'), JSON.stringify({ id: 'u1', root: home }));
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: later })).map((f) => f.path).sort(), [...old].sort());
    assert.deepEqual((await findRemovable({ keepTag: 'b9999' })).map((f) => f.path), [], '書いている最中の一時ファイルを消そうとした');
  });

  test('作業場の根を持たない古い戻り先は消す。根を持つもの（別の作業場のものも）・読めないものは消さない', async () => {
    const { home } = await scratch();
    const undo = join(home, 'undo');
    await mkdir(undo, { recursive: true });
    await writeFile(join(undo, 'old.json'), JSON.stringify({ id: 'old', files: [] }));
    await writeFile(join(undo, 'here.json'), JSON.stringify({ id: 'here', root: home, files: [] }));
    await writeFile(join(undo, 'there.json'), JSON.stringify({ id: 'there', root: '/somewhere/else', files: [] }));
    await writeFile(join(undo, 'broken.json'), '{');
    await writeFile(join(undo, 'nothing.json'), 'null');
    await writeFile(join(undo, 'no-id.json'), JSON.stringify({ files: [] }));
    await writeFile(join(undo, 'text.json'), JSON.stringify('x'));
    const later = Date.now() + 31 * 86_400_000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: later })).map((f) => f.path), [join(undo, 'old.json')]);
  });

  test('**根の無い戻り先でも、新しいものは挙げない**（根を持たせる前の版が今も書いていて、その画面では使える）', async () => {
    const { home } = await scratch();
    const undo = join(home, 'undo');
    await mkdir(undo, { recursive: true });
    await writeFile(join(undo, 'recent.json'), JSON.stringify({ id: 'recent', files: [] }));
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: Date.now() + 29 * 86_400_000 })).map((f) => f.path), []);
  });

  test('**本物の書き手が書いたもの（戻り先・一部を戻せなかった後の書き直し・記憶・段取り・やり残し）は挙げない**', async () => {
    const { home } = await scratch();
    const work = join(home, 'work');
    await mkdir(work, { recursive: true });
    const { UndoStore } = await import('../src/core/undo.ts');
    const { Memory } = await import('../src/memory/memory.ts');
    const { Goals } = await import('../src/core/goals.ts');
    const { UnfinishedWork } = await import('../src/core/unfinished.ts');
    const u = new UndoStore(work, join(home, 'undo'));
    await writeFile(join(work, 'a.txt'), 'a0');
    await writeFile(join(work, 'b.txt'), 'b0');
    await u.begin('直す'); u.capture('a.txt', 'a0'); u.capture('b.txt', 'b0'); await u.end();
    await u.begin('もう一度'); u.capture('a.txt', 'a1'); await u.end();
    // b.txt を中身の在るフォルダにして、一部を戻せない形で戻す（戻り先の書き直しを通す）。
    await rm(join(work, 'b.txt'));
    await mkdir(join(work, 'b.txt'));
    await writeFile(join(work, 'b.txt', 'x'), 'x');
    const first = (await u.list()).find((p) => p.request === '直す')!;
    assert.deepEqual((await u.restore(first.id))?.failed, ['b.txt']);
    const m = new Memory(join(home, 'memory.jsonl'));
    m.remember({ kind: 'fact', title: '覚える', tags: [] });
    await m.save();
    await new Goals(join(home, 'goals.jsonl')).open('依頼', ['読む']);
    await new UnfinishedWork(join(home, 'unfinished.jsonl')).add({ request: '依頼', why: 'maxTurns', note: '' });
    const far = Date.now() + 365 * 86_400_000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: far })).map((f) => f.path), [], '書き手が書いたものを挙げた');
  });

  test('途中で切れた取得は消す（1 時間より古いもの）', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'm.gguf.part'), 'x');
    await writeFile(join(models, 'm.gguf'), 'GGUF');
    const found = await findRemovable({ keepTag: 'b9999', now: Date.now() + 2 * 60 * 60 * 1000 });
    assert.deepEqual(found.map((f) => f.path), [join(models, 'm.gguf.part')]);
  });

  test('途中の分の版の記録（.part.tag）も、途中の分と一緒に片づける', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'm.gguf.part'), 'x');
    await writeFile(join(models, 'm.gguf.part.tag'), '"v1"');
    const found = await findRemovable({ keepTag: 'b9999', now: Date.now() + 2 * 60 * 60 * 1000 });
    assert.deepEqual(found.map((f) => f.path).sort(), [join(models, 'm.gguf.part'), join(models, 'm.gguf.part.tag')]);
  });

  test('いま取っている最中の取得は消さない（書き続けているので新しい）', async () => {
    const { models, bin } = await scratch();
    await writeFile(join(models, 'm.gguf.part'), 'x');
    await writeFile(join(bin, 'llama.zip.partial'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), [], '取得中のファイルを消す一覧に載せた（消すと、取得が壊れる）');
  });

  test('古い llama-server は消すが、いま使っている版は残す', async () => {
    const { bin } = await scratch();
    await mkdir(join(bin, 'b1000'));
    await mkdir(join(bin, 'b2000'));
    // 版の形をしていないものは触らない。知らない名前を消さない。
    await mkdir(join(bin, 'なにか'));
    const found = await findRemovable({ keepTag: 'b2000' });
    assert.deepEqual(found.map((f) => f.path), [join(bin, 'b1000')]);
  });

  test('新しい記録は残す', async () => {
    const { home } = await scratch();
    const logs = join(home, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'today.log'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), []);
  });

  test('記録・添付のフォルダの下のフォルダは、古くても挙げない（中身ごと消すことになる）', async () => {
    const { home } = await scratch();
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    for (const sub of ['logs', 'attachments']) {
      const dir = join(home, sub, 'だれかのフォルダ');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '中身.txt'), 'x');
      await utimes(dir, longAgo, longAgo);
    }
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), []);
  });

  test('置き場が無くても落ちない', async () => {
    process.env.AAS_HOME = join(await tempDir('aas-none-'), 'まだ無い');
    assert.deepEqual(await findRemovable({ keepTag: 'b1' }), []);
  });
});

describe('前に渡した添付', () => {
  test('1日より古いものは片づける対象。新しいものは残す（対）', async () => {
    const { home } = await scratch();
    const { join: j } = await import('node:path');
    const { mkdir: mk, writeFile: wf, utimes } = await import('node:fs/promises');
    const dir = j(home, 'attachments');
    await mk(dir, { recursive: true });
    await wf(j(dir, 'old-a.txt'), 'x');
    await wf(j(dir, 'new-b.txt'), 'y');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(j(dir, 'old-a.txt'), old, old);
    const found = await findRemovable({ keepTag: 'b1' });
    const names = found.map((f) => f.path.split(/[\\/]/).at(-1));
    assert.ok(names.includes('old-a.txt'), '古い添付が対象に無い');
    assert.ok(!names.includes('new-b.txt'), '新しい添付まで消そうとしている');
  });

  /**
   * 記録は増えるだけで、減る道が無かった。作業場に doctor-…txt が 37 個
   * 並び、横の一覧がそれで埋まった（実機）。新しい方から 10 件だけ残す。
   */
  test('**古い記録は挙げる。新しい 10 件は残す**', async () => {
    const { home } = await scratch();
    const reports = join(home, 'reports');
    await mkdir(reports, { recursive: true });
    for (let i = 1; i <= 14; i += 1) {
      await writeFile(join(reports, `doctor-20260901-${String(1000 + i)}.txt`), 'x');
    }
    const found = await findRemovable({ keepTag: 'b9999' });
    const names = found.map((f) => f.path.split(/[\\/]/).at(-1)).sort();
    assert.deepEqual(names, [
      'doctor-20260901-1001.txt', 'doctor-20260901-1002.txt', 'doctor-20260901-1003.txt',
      'doctor-20260901-1004.txt',
    ], `挙げたものが違う: ${names.join(', ')}`);
    assert.ok(found.every((f) => f.why.includes('古い doctor の記録')), JSON.stringify(found));
  });

  test('**記録に見えないものは触らない（対）**', async () => {
    const { home } = await scratch();
    const reports = join(home, 'reports');
    await mkdir(reports, { recursive: true });
    // 15 個置いても、名前の形が違えば対象にしない。
    for (let i = 1; i <= 15; i += 1) {
      await writeFile(join(reports, `メモ${i}.txt`), 'x');
      await writeFile(join(reports, `doctor-${i}.txt`), 'x');
    }
    assert.deepEqual(await findRemovable({ keepTag: 'b9999' }), [], '関係ないものを消そうとしている');
  });
});

describe('取得中の .part.tag（92 回目の調査）', () => {
  test('.part が書き続けられているなら、古い .part.tag も消さない', async () => {
    const { models } = await scratch();
    const { utimes } = await import('node:fs/promises');
    await writeFile(join(models, 'x.gguf.part'), 'a');
    await writeFile(join(models, 'x.gguf.part.tag'), 'etag');
    // .tag は取り始めに一度だけ書く。1 時間を超えて取り続けると、.tag だけが古くなる
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(models, 'x.gguf.part.tag'), old, old);
    const listed = (await findRemovable({ keepTag: 'b1' })).map((f) => f.path);
    assert.deepEqual(listed.filter((p) => p.includes('x.gguf')), [], listed.join('\n'));
  });

  test('.part も古ければ、.tag と一緒に挙げる（対）', async () => {
    const { models } = await scratch();
    const { utimes } = await import('node:fs/promises');
    await writeFile(join(models, 'y.gguf.part'), 'a');
    await writeFile(join(models, 'y.gguf.part.tag'), 'etag');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(models, 'y.gguf.part'), old, old);
    await utimes(join(models, 'y.gguf.part.tag'), old, old);
    const listed = (await findRemovable({ keepTag: 'b1' })).map((f) => f.path);
    assert.equal(listed.filter((p) => p.includes('y.gguf')).length, 2, listed.join('\n'));
  });
});

describe('動いている llama-server の版は挙げない（DECISIONS 10-11、106 回目）', () => {
  test('動いている古い版は残し、動いていない古い版だけ挙げる', { skip: process.platform === 'win32' && 'Windows は動いている実行ファイルを OS が消させない' }, async () => {
    const { bin } = await scratch();
    for (const tag of ['b100', 'b200', 'b300']) await mkdir(join(bin, tag), { recursive: true });
    // 引数に b100 の下の道を持つプロセスを一つ動かす（ps の args に出る）
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', join(bin, 'b100', 'llama-server')], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const paths = (await findRemovable({ keepTag: 'b300' })).map((f) => f.path);
      assert.ok(!paths.includes(join(bin, 'b100')), '動いている版を消す一覧に挙げた');
      assert.ok(paths.includes(join(bin, 'b200')), '動いていない古い版を挙げなくなった');
    } finally {
      child.kill();
    }
  });

  test('何が動いているか分からなければ、古い版は挙げない', async () => {
    const { bin } = await scratch();
    await mkdir(join(bin, 'b200'), { recursive: true });
    const paths = (await findRemovable({ keepTag: 'b300', runningTags: async () => undefined })).map((f) => f.path);
    assert.ok(!paths.includes(join(bin, 'b200')));
  });
});

describe('消した量の言い方', () => {
  test('1MB に満たないものを 0MB と言わない', async () => {
    const { mb } = await import('../src/runtime/cleanup.ts');
    assert.equal(mb(0), '0KB');
    assert.equal(mb(1), '1KB');
    assert.equal(mb(300 * 1024), '300KB');
    assert.equal(mb(5 * 1024 * 1024), '5MB');
    assert.equal(mb(2 * 1024 ** 3), '2.0GB');
  });
});

describe('取り直したときに脇へ移した前の版', () => {
  test('戻せずに残った <tag>.<pid>.prev は挙げる。移している最中の新しいものと、似た名前は挙げない', async () => {
    const { bin } = await scratch();
    await mkdir(join(bin, 'b9999'), { recursive: true });
    await mkdir(join(bin, 'b4585.1234.prev'), { recursive: true });
    await writeFile(join(bin, 'b4585.1234.prev', 'llama-server'), 'x');
    await mkdir(join(bin, 'notes.prev'), { recursive: true });
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const none = async () => new Set<string>();
    assert.deepEqual(
      (await findRemovable({ keepTag: 'b9999', now: later, runningTags: none })).map((f) => f.path),
      [join(bin, 'b4585.1234.prev')],
    );
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', runningTags: none })).map((f) => f.path), [], '移している最中のものを挙げた');
  });
});
