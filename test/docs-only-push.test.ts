/**
 * 文書だけの push を、そのまま出さないところ。
 *
 * ci.yml の `paths-ignore` は効かない。GitHub は `pull_request` の path 判定を
 * PR 全体の差分（head と base）で行うので、PR に一度でもコードが入っていれば、
 * そのあと文書だけを押しても当たらない。この repo は push では回さないため、
 * **開いている PR への文書だけの push は毎回 1 回ぶん枠を食う**。
 * docs/HANDOFF.md の 1 ファイルだけのコミットで run が立った（2026-09-22 JST）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { docsOnlyPush, SKIP_MARK } from '../scripts/docs-only-push.mjs';

describe('文書だけの push', () => {
  test('文書だけなら止める。通り道も言う', () => {
    const why = docsOnlyPush({ files: ['docs/HANDOFF.md'], message: '引き継ぎに書く' });
    assert.ok(why, '止めていない');
    assert.match(why, /1 ファイル/);
    assert.match(why, /まとめる/, `次の push にまとめる道を言っていない: ${why}`);
    assert.match(why, /\[skip ci\]/, `もう一つの道を言っていない: ${why}`);
  });

  test('コードが一つでも混ざっていれば、止めない', () => {
    // ここで止めると、コードの直しが確かめられずに出ることになる。
    assert.equal(
      docsOnlyPush({ files: ['docs/HANDOFF.md', 'src/core/home.ts'], message: '直す' }),
      undefined,
    );
  });

  test('題に [skip ci] が付いていれば、止めない（自分で言っている）', () => {
    assert.equal(
      docsOnlyPush({ files: ['docs/HANDOFF.md'], message: `引き継ぎに書く ${SKIP_MARK}` }),
      undefined,
    );
    // 本文に書いてあっても効く（GitHub は題も本文も見る）。
    assert.equal(
      docsOnlyPush({ files: ['README.md'], message: `直す\n\n${SKIP_MARK}` }),
      undefined,
    );
  });

  test('ci.yml が挙げている並びを、全部わかる', async () => {
    /*
     * **ci.yml そのものを読む。**並びを手で写していたので、ci.yml に足しても
     * ここは古いまま通った（片方だけ直すと食い違う、と注釈にだけ書いてあった）。
     * glob ごとに見本の道を作り、文書として見ているかを確かめる。
     */
    const raw = (await readFile(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8'))
      .replace(/\r\n/g, '\n');
    const list = /paths-ignore:\s*\[([^\]]*)\]/.exec(raw)?.[1];
    assert.ok(list, 'ci.yml の paths-ignore が読めない');
    const globs = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    assert.ok(globs.length >= 5, `並びが短すぎる: ${globs.join(', ')}`);
    for (const glob of globs) {
      const sample = glob.replace(/\*\*/g, 'a/b').replace(/\*/g, 'x');
      assert.ok(docsOnlyPush({ files: [sample], message: '直す' }), `${glob}（${sample}）を文書として見ていない`);
    }
  });

  test('`.claude/` の下は文書と同じ扱い。製品のコードは違う（対）', () => {
    assert.ok(docsOnlyPush({ files: ['.claude/hooks/lessons.sh'], message: '直す' }));
    assert.equal(docsOnlyPush({ files: ['.claude/hooks/lessons.sh', 'src/a.ts'], message: '直す' }), undefined);
    assert.equal(docsOnlyPush({ files: ['claude/x.ts'], message: '直す' }), undefined);
  });

  test('何も変わっていない push では、何も言わない', () => {
    assert.equal(docsOnlyPush({ files: [], message: '直す' }), undefined);
    assert.equal(docsOnlyPush({ files: [''], message: '直す' }), undefined);
  });
});
