/**
 * **承認を待っているあいだに、ディスクが変わることがある。**
 *
 * 書き換えるツールは、中身を読む → 差分を作る → 承認を訊く → 書く、の順で動く。
 * 訊いてからの返事は 10 分待つ（`src/ui/server.ts`）ので、その間に人が外の
 * エディタで直して保存し、それから許可を押す、が普通に起きる。
 *
 * そこで**待つ前に読んだ中身をそのまま書いて**いたので、人の直しが消えた。
 * しかも戻り先へ控えるのも待つ前の中身なので、**戻しても返ってこない。**
 * 消えたことに気づく道が、どこにも無い形だった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { writeFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext, ApprovalAnswer } from '../src/agent/tools/types.ts';

/** 承認のあいだに `during` を走らせる文脈。控えた分も覚えておく。 */
function ctxWith(root: string, during: () => Promise<void>) {
  const kept: Array<{ path: string; previous: string | undefined }> = [];
  const ctx: ToolContext = {
    root,
    signal: new AbortController().signal,
    approve: async (): Promise<ApprovalAnswer> => { await during(); return true; },
    beforeWrite: (path, previous) => { kept.push({ path, previous }); },
  };
  return { ctx, kept };
}

describe('承認を待っているあいだに変わったら', () => {
  test('**人の直しを、古い中身で上書きしない**', async () => {
    const root = await tempDir('aas-stale-');
    await writeFile(join(root, 'a.txt'), 'もとの\n');
    const { ctx, kept } = ctxWith(root, async () => {
      // 人が外のエディタで直して保存した。
      await writeFile(join(root, 'a.txt'), 'もとの\n人が足した\n');
    });

    const r = await writeFileTool.run({ path: 'a.txt', content: 'モデルが書いた\n' }, ctx);

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'もとの\n人が足した\n',
      '待っているあいだの直しを、古い中身で上書きしている');
    assert.equal(r.isError, true, `書けていないのに、書けたと返している: ${r.content}`);
    assert.match(r.content, /変わりました/, r.content);
    assert.deepEqual(kept, [], '書いていないのに戻り先へ控えている');
  });

  test('変わっていなければ、これまでどおり書く（対）', async () => {
    const root = await tempDir('aas-stale-ok-');
    await writeFile(join(root, 'a.txt'), 'もとの\n');
    const { ctx, kept } = ctxWith(root, async () => { /* 何も起きない */ });

    const r = await writeFileTool.run({ path: 'a.txt', content: 'モデルが書いた\n' }, ctx);

    assert.equal(r.isError, undefined, r.content);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'モデルが書いた\n');
    assert.deepEqual(kept, [{ path: 'a.txt', previous: 'もとの\n' }], '戻り先へ控えていない');
  });

  test('**待っているあいだに誰かが作ったファイルを、上書きしない**', async () => {
    const root = await tempDir('aas-stale-new-');
    const { ctx } = ctxWith(root, async () => {
      await writeFile(join(root, 'b.txt'), '人が作った\n');
    });

    const r = await writeFileTool.run({ path: 'b.txt', content: 'モデルが作った\n' }, ctx);

    assert.equal(r.isError, true, `上書きしている: ${r.content}`);
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), '人が作った\n');
  });
});

describe('空のファイル', () => {
  test('**無いファイルは、空でも作る**', async () => {
    const root = await tempDir('aas-empty-');
    const ctx: ToolContext = {
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true),
    };
    const r = await writeFileTool.run({ path: 'empty.txt', content: '' }, ctx);
    assert.equal(r.isError, undefined, r.content);
    assert.ok(await stat(join(root, 'empty.txt')).catch(() => undefined),
      `「${r.content}」と言うだけで、ファイルが出来ていない`);
    assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), '');
  });

  test('在るファイルに同じ中身なら、これまでどおり「変更なし」（対）', async () => {
    const root = await tempDir('aas-nochange-');
    await writeFile(join(root, 'a.txt'), 'そのまま\n');
    const ctx: ToolContext = {
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true),
    };
    const r = await writeFileTool.run({ path: 'a.txt', content: 'そのまま\n' }, ctx);
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /変更なし/, r.content);
  });
});

/**
 * **同じファイルへ、二人が同時に書いたとき。**
 *
 * 押さえているのは段取りが宣言した書き込み先だけ（`src/core/scheduler.ts`）で、
 * 宣言は模型の当て推量。宣言に無ければ、同じファイルへ二人が同時に入る。
 * 読み直して見比べてから書くまでのあいだに相手の書き込みが挟まると、
 * **どちらも「書けた」と返すのに、片方の中身しか残らない。**
 */
describe('同じファイルへ二人が同時に書く', () => {
  test('**片方だけが通り、もう片方は変わったと返す**', async () => {
    const root = await tempDir('aas-race-');
    await writeFile(join(root, 'a.txt'), 'もとの\n');
    const ctx: ToolContext = {
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true),
    };

    const [one, two] = await Promise.all([
      writeFileTool.run({ path: 'a.txt', content: '担当 A\n' }, ctx),
      writeFileTool.run({ path: 'a.txt', content: '担当 B\n' }, ctx),
    ]);

    const wrote = [one, two].filter((r) => r.isError === undefined);
    const refused = [one, two].filter((r) => r.isError === true);
    assert.equal(wrote.length, 1,
      `両方が書けたことになっている: ${JSON.stringify([one.content, two.content])}`);
    assert.equal(refused.length, 1);
    assert.match(refused[0]!.content, /変わりました/, refused[0]!.content);

    // 残った中身は、通った方のもの（混ざらない）。
    const now = await readFile(join(root, 'a.txt'), 'utf8');
    assert.ok(now === '担当 A\n' || now === '担当 B\n', `中身が混ざっている: ${JSON.stringify(now)}`);
    assert.ok(wrote[0]!.content.includes('更新'), wrote[0]!.content);
  });

  test('別のファイルなら、二人とも書ける（対）', async () => {
    const root = await tempDir('aas-race-ok-');
    await writeFile(join(root, 'a.txt'), 'もとの a\n');
    await writeFile(join(root, 'b.txt'), 'もとの b\n');
    const ctx: ToolContext = {
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true),
    };
    const [one, two] = await Promise.all([
      writeFileTool.run({ path: 'a.txt', content: '直した a\n' }, ctx),
      writeFileTool.run({ path: 'b.txt', content: '直した b\n' }, ctx),
    ]);
    assert.equal(one.isError, undefined, one.content);
    assert.equal(two.isError, undefined, two.content);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '直した a\n');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), '直した b\n');
  });
});
