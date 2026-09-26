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
    cli.add(input('端末が足した'));
    cli.setStatus('p001', 'rejected');
    await cli.save();
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

  test('**空の番号・当たりが二つ以上の前方一致では、どの提案にも当てない**', async () => {
    const titles = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const { q } = await queueWith('find', titles);
    assert.equal(q.find(''), undefined, '空で先頭の提案に当たった');
    assert.equal(q.find('p01'), undefined, '当たりが二つ（p010・p011）なのに一つを選んだ');
    assert.equal(q.find('p011')?.title, 't10');
    assert.equal(q.find('p00')?.id, undefined);
    assert.equal(q.find('p009')?.title, 't8');
  });

  test('調べ終えた指紋は、上限を超えたら古い方から落とす', async () => {
    const { path, q } = await queueWith('examined', []);
    for (let i = 0; i < MAX_EXAMINED + 500; i += 1) q.markExamined(`fp${i}`);
    await q.save();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { examined: string[] };
    assert.equal(saved.examined.length, MAX_EXAMINED);
    assert.equal(saved.examined[0], 'fp500', '新しい方を落とした');
  });
});
