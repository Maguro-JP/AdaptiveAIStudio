/**
 * 提案の記録で、起動ごと止まる・読めないときに空で上書きする・二つの実体で消し合う・別の提案に当たる形を止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { ProposalQueue, MAX_EXAMINED } from '../src/agent/proposals.ts';

const require = createRequire(import.meta.url);

function input(title: string) {
  return { kind: 'bug' as const, title, rationale: 'r', evidence: [], suggestedAction: `${title} を直す`, fingerprint: `fp:${title}` };
}

async function queueWith(name: string, titles: string[]) {
  const path = join(await tempDir(`aas-prop-${name}-`), 'proposals.json');
  const q = new ProposalQueue(path);
  for (const t of titles) q.add(input(t));
  await q.save();
  return { path, q };
}

describe('提案の記録', () => {
  test('**形の違う一件（null）や items が配列でない形で、読み込みごと止まらない**', async () => {
    const { path } = await queueWith('shape', ['a', 'b']);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { items: unknown[] };
    await writeFile(path, JSON.stringify({ items: [null, ...saved.items, 42] }));
    const q = new ProposalQueue(path);
    await q.load();
    assert.deepEqual(q.all().map((p) => p.title), ['a', 'b']);
    await writeFile(path, JSON.stringify({ items: {} }));
    await assert.doesNotReject(new ProposalQueue(path).load());
  });

  test('**読めない（EBUSY）ときは、空として始めても、溜めていた提案を上書きしない**', async () => {
    const { path } = await queueWith('busy', ['a', 'b', 'c']);
    const before = await readFile(path, 'utf8');
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const real = fsp.readFile;
    (fsp as { readFile: unknown }).readFile = (...args: Parameters<typeof real>) =>
      String(args[0]) === path ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : real(...args);
    syncBuiltinESMExports();
    try {
      const q = new ProposalQueue(path);
      await q.load();
      q.add(input('読めない間の提案'));
      await q.save();
    } finally {
      (fsp as { readFile: unknown }).readFile = real;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(path, 'utf8'), before, '溜めていた提案を上書きした');
  });

  test('**JSON として読めない（書きかけで落ちた）ファイルは、脇へ移してから始める**', async () => {
    const { path } = await queueWith('broken', ['a', 'b']);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.slice(0, Math.floor(text.length / 2)));
    const q = new ProposalQueue(path);
    await q.load();
    const names = await readdir(join(path, '..'));
    assert.ok(names.some((n) => n.startsWith('proposals.json.broken-')), `脇へ移していない: ${names.join(',')}`);
    q.add(input('新しい提案'));
    await q.save();
    assert.match(await readFile(path, 'utf8'), /新しい提案/);
  });

  test('**二つの実体（画面と端末）が別々に足しても決めても、互いに消さず、同じ番号を二つの提案に配らない**', async () => {
    const { path } = await queueWith('two', ['a', 'b']);
    const ui = new ProposalQueue(path);
    const cli = new ProposalQueue(path);
    await ui.load();
    await cli.load();
    ui.add(input('画面が足した'));
    await ui.save();
    const shown = cli.add(input('端末が足した'))!;
    const shownId = shown.id; // 端末が出す番号
    cli.setStatus('p001', 'rejected');
    await cli.save();
    assert.equal(shown.id, shownId, '保存で番号を振り直した（出した番号が別の提案を指す）');
    assert.equal(cli.find(shownId)?.title, '端末が足した');
    const after = new ProposalQueue(path);
    await after.load();
    const titles = after.all().map((p) => p.title).sort();
    assert.deepEqual(titles, ['a', 'b', '画面が足した', '端末が足した'].sort(), '片方の提案が消えた');
    const ids = after.all().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `同じ番号を二つに配った: ${ids.join(',')}`);
    // 画面が自分の提案を採ったあと保存しても、端末の却下を戻さない。
    ui.setStatus(ui.all().find((p) => p.title === '画面が足した')!.id, 'accepted');
    await ui.save();
    const last = new ProposalQueue(path);
    await last.load();
    assert.equal(last.all().find((p) => p.title === 'a')?.status, 'rejected', '却下が戻った');
    assert.equal(last.all().find((p) => p.title === '画面が足した')?.status, 'accepted');
  });

  test('**もう一方が決めた提案を、古い手元から決め直さない。実行し終えたものを、採っただけの側が戻さない**', async () => {
    const { path } = await queueWith('settle', ['a', 'b']);
    const ui = new ProposalQueue(path);
    const cli = new ProposalQueue(path);
    await ui.load();
    await cli.load();
    assert.ok(await ui.settle('p001', 'rejected', { onlyOpen: true }));
    assert.equal(await cli.settle('p001', 'accepted', { onlyOpen: true }), undefined, '却下された提案を採れた');
    // b: 画面が採って実行し終える。端末は採っただけの手元のまま保存する。
    assert.ok(await ui.settle('p002', 'accepted', { onlyOpen: true }));
    await cli.load();
    await ui.settle('p002', 'done');
    await cli.save();
    const after = new ProposalQueue(path);
    await after.load();
    assert.equal(after.find('p001')?.status, 'rejected');
    assert.equal(after.find('p002')?.status, 'done', '実行し終えたものを、採っただけの状態に戻した');
  });

  test('両方が保存前に同じ発見を足しても、一件にまとめる', async () => {
    const { path } = await queueWith('same', ['a']);
    const ui = new ProposalQueue(path);
    const cli = new ProposalQueue(path);
    await ui.load();
    await cli.load();
    ui.add(input('同じ発見'));
    // 別の手がかりから同じ発見に行き着いた形（指紋は違い、題が同じ）。
    cli.add({ ...input('同じ発見'), fingerprint: 'fp:別の手がかり' });
    await ui.save();
    await cli.save();
    const after = new ProposalQueue(path);
    await after.load();
    assert.equal(after.all().filter((p) => p.title === '同じ発見').length, 1);
  });

  test('**脇へ移せず写しも取れないときは、壊れたファイルを空で上書きしない**', async () => {
    const { path } = await queueWith('no-aside', ['a']);
    const broken = '{"items":[{"id":"p001"';
    await writeFile(path, broken);
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const realRename = fsp.rename;
    const realCopy = fsp.copyFile;
    const deny = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }));
    (fsp as { rename: unknown }).rename = (from: string, to: string) => String(to).includes('.broken-') ? deny() : realRename(from, to);
    (fsp as { copyFile: unknown }).copyFile = deny;
    syncBuiltinESMExports();
    try {
      const q = new ProposalQueue(path);
      await q.load();
      q.add(input('新しい提案'));
      await q.save();
    } finally {
      (fsp as { rename: unknown }).rename = realRename;
      (fsp as { copyFile: unknown }).copyFile = realCopy;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(path, 'utf8'), broken, '壊れたファイルを上書きした');
  });

  test('形の違う一件は、次の保存で元のまま書き戻す', async () => {
    const { path } = await queueWith('odd', ['a']);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { items: unknown[] };
    const odd = { id: 'p777', title: '手で直している途中' };
    await writeFile(path, JSON.stringify({ items: [...saved.items, odd] }));
    const q = new ProposalQueue(path);
    await q.load();
    q.add(input('b'));
    await q.save();
    const after = JSON.parse(await readFile(path, 'utf8')) as { items: unknown[] };
    assert.ok(after.items.some((x) => JSON.stringify(x) === JSON.stringify(odd)), '形の違う一件を消した');
  });

  test('一度だけ掴まれていた（EBUSY）なら、読み直して読み込む', async () => {
    const { path } = await queueWith('busy-once', ['a', 'b']);
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const real = fsp.readFile;
    let failed = 0;
    (fsp as { readFile: unknown }).readFile = (...args: Parameters<typeof real>) => {
      if (String(args[0]) === path && failed === 0) { failed += 1; return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })); }
      return real(...args);
    };
    syncBuiltinESMExports();
    try {
      const q = new ProposalQueue(path);
      await q.load();
      assert.equal(q.all().length, 2);
    } finally {
      (fsp as { readFile: unknown }).readFile = real;
      syncBuiltinESMExports();
    }
  });

  test('**空の番号・当たりが二つ以上の前方一致では、どの提案にも当てない**', async () => {
    const titles = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const { q } = await queueWith('find', titles);
    assert.equal(q.find(''), undefined, '空で先頭の提案に当たった');
    assert.equal(q.find('p01'), undefined, '当たりが二つ（p010・p011）なのに一つを選んだ');
    assert.equal(q.find('p011')?.title, 't10');
    assert.equal(q.find('p00')?.id, undefined);
    assert.equal(q.find('p009')?.title, 't8');
  });

  test('**調べ終えた指紋が上限に達したあとも、新しい指紋は保存で消えない**（古い方から落とす）', async () => {
    const { path, q } = await queueWith('examined', []);
    for (let i = 0; i < MAX_EXAMINED + 500; i += 1) q.markExamined(`old${i}`);
    await q.save();
    q.markExamined('new0');
    await q.save();
    q.markExamined('new1');
    await q.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { examined: string[] };
    assert.equal(saved.examined.length, MAX_EXAMINED);
    assert.ok(saved.examined.includes('new0') && saved.examined.includes('new1'), '新しい指紋が保存で消えた');
    assert.ok(!saved.examined.includes('old0'), '古い方を残して新しい方を落とした');
    assert.ok(q.seen().has('new0'), '手元からも消えた');
  });

  test('**採否を書けなかったときは、決まったことにしない**（手元も開いたまま、もう一度決められる）', async () => {
    const { path } = await queueWith('settle-write-fails', ['a']);
    const q = new ProposalQueue(path);
    await q.load();
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const realRename = fsp.rename;
    (fsp as { rename: unknown }).rename = (from: string, to: string) => to === path
      ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
      : realRename(from, to);
    syncBuiltinESMExports();
    try {
      await assert.rejects(q.settle('p001', 'accepted', { onlyOpen: true }), /採否を保存できませんでした.*disk full/);
    } finally {
      (fsp as { rename: unknown }).rename = realRename;
      syncBuiltinESMExports();
    }
    assert.equal(q.find('p001')?.status, 'open', '書けなかった採否が手元で決まったままになっている');
    const disk = new ProposalQueue(path);
    await disk.load();
    assert.equal(disk.find('p001')?.status, 'open');
    // 書けるようになれば、同じ提案をもう一度決められる
    assert.equal((await q.settle('p001', 'accepted', { onlyOpen: true }))?.status, 'accepted');
    const after = new ProposalQueue(path);
    await after.load();
    assert.equal(after.find('p001')?.status, 'accepted');
  });

  test('**記録を読めないときは、「見つからない」と取り違えず、読めなかったと言う**', async () => {
    const { path } = await queueWith('settle-read-fails', ['a']);
    const q = new ProposalQueue(path);
    await q.load();
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const realRead = fsp.readFile;
    (fsp as { readFile: unknown }).readFile = ((file: unknown, ...rest: unknown[]) => file === path
      ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      : (realRead as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as never;
    syncBuiltinESMExports();
    try {
      await assert.rejects(q.settle('p001', 'rejected', { onlyOpen: true }), /提案の記録を読めませんでした/);
    } finally {
      (fsp as { readFile: unknown }).readFile = realRead;
      syncBuiltinESMExports();
    }
    assert.equal(q.find('p001')?.status, 'open');
  });
});

describe('提案を残せないとき', () => {
  test('読めない記録には書かず、残せなかったことを返す（黙って「登録しました」と言わせない）', async () => {
    const dir = await tempDir('aas-prop-unsaved-');
    const path = join(dir, 'proposals.json');
    // 読めなさはフォルダで作る（EISDIR。権限に頼らない）
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path);
    const q = new ProposalQueue(path);
    q.add(input('残らない提案'));
    const failed = await q.save();
    assert.match(failed?.message ?? '', /残せませんでした/, '残せなかったことを返していない');
  });

  test('残せたときは、何も返さない（対）', async () => {
    const path = join(await tempDir('aas-prop-saved-'), 'proposals.json');
    const q = new ProposalQueue(path);
    q.add(input('残る提案'));
    assert.equal(await q.save(), undefined);
  });
});
