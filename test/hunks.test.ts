/**
 * 差分を、塊ごとに受け入れる。
 *
 * 全部通すか全部戻すかしか無いと、3か所直したうちの1か所が違うだけで、
 * 直っている2か所ごと捨てることになる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { unifiedDiff, diffStat } from '../src/agent/diff.ts';
import { splitHunks, applyHunks } from '../src/agent/hunks.ts';
import * as hunksApi from '../src/agent/hunks.ts';
import { writeFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext, ApprovalAnswer } from '../src/agent/tools/types.ts';

const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
const after = before.split('\n').map((l, i) => (i === 2 ? 'X' : i === 20 ? 'Y' : l)).join('\n');
const diff = unifiedDiff('a.ts', before, after);

describe('塊に割る', () => {
  test('離れた2か所は、2つの塊になる', () => {
    assert.equal(splitHunks(diff).length, 2);
  });
  test('差分でなければ空', () => {
    assert.deepEqual(splitHunks('ただの文'), []);
  });
});

describe('選んだ塊だけ当てる', () => {
  test('前だけ', () => {
    assert.equal(applyHunks(before, diff, [0]),
      before.split('\n').map((l, i) => (i === 2 ? 'X' : l)).join('\n'));
  });
  test('後ろだけ', () => {
    assert.equal(applyHunks(before, diff, [1]),
      before.split('\n').map((l, i) => (i === 20 ? 'Y' : l)).join('\n'));
  });
  test('両方なら、全部当てたのと同じ', () => {
    assert.equal(applyHunks(before, diff, [0, 1]), after);
  });
  test('一つも選ばなければ、元のまま', () => {
    assert.equal(applyHunks(before, diff, []), before);
  });
  test('番号が外れていれば、当てない', () => {
    assert.equal(applyHunks(before, diff, [5]), undefined);
  });
  test('元の中身が食い違えば、当てない（ずれた所を壊さない）', () => {
    assert.equal(applyHunks('まるで別の中身', diff, [0]), undefined);
  });
});

function ctxAt(root: string, answer: ApprovalAnswer): ToolContext {
  return { root, signal: new AbortController().signal, approve: () => Promise.resolve(answer) };
}

describe('書き込みは、通った塊だけ', () => {
  test('一部だけ通ると、その分だけ書かれる', async () => {
    const root = await tempDir('aas-hunk-');
    await writeFile(join(root, 'a.ts'), before);
    const r = await writeFileTool.run({ path: 'a.ts', content: after }, ctxAt(root, { hunks: [0] }));
    assert.equal(r.isError, undefined);
    assert.match(r.content, /2 か所のうち 1 か所/);
    const got = await readFile(join(root, 'a.ts'), 'utf8');
    assert.equal(got, before.split('\n').map((l, i) => (i === 2 ? 'X' : l)).join('\n'));
  });

  test('一つも通らなければ、書かない', async () => {
    const root = await tempDir('aas-hunk-');
    await writeFile(join(root, 'a.ts'), before);
    const r = await writeFileTool.run({ path: 'a.ts', content: after }, ctxAt(root, { hunks: [] }));
    assert.equal(r.isError, true);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), before);
  });

  test('全部通れば、これまで通り', async () => {
    const root = await tempDir('aas-hunk-');
    await writeFile(join(root, 'a.ts'), before);
    const r = await writeFileTool.run({ path: 'a.ts', content: after }, ctxAt(root, true));
    assert.equal(r.isError, undefined);
    assert.doesNotMatch(r.content, /か所だけ/);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), after);
  });
});

test('終わりの改行を、空の一行として数えない', () => {
  // 「console.log(1);\n」を書いて「+2 -0、2 行目が空」と出ていた。
  const d = unifiedDiff('hello.js', '', 'console.log(1);\n');
  const added = d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  assert.deepEqual(added, ['+console.log(1);']);
  // 終わりの改行の有無だけの違いは、改行の無い側に知らせの行を付けて出す（空の差分のまま承認に出すと、許したときに黙って改行が変わった）
  const eol = unifiedDiff('a.txt', 'x', 'x\n');
  assert.match(eol, /^-x\n\\ No newline at end of file\n\+x$/m, eol);
  assert.match(unifiedDiff('a.txt', 'x\n', 'x'), /^\+x\n\\ No newline at end of file$/m);
  assert.deepEqual(diffStat(eol), { added: 1, removed: 1 });
});

describe('当てたあとから、塊ごと・行ごとに戻す', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const after = 'a\nB\nc\nd\ne\nf\nG\nG2\nh\n';
  const diff = unifiedDiff('x.txt', before, after, 1);

  test('塊ごと戻す', () => {
    const { revertLines, splitHunks } = hunksApi;
    assert.equal(splitHunks(diff).length, 2, `塊が 2 つでない:\n${diff}`);
    assert.equal(revertLines(after, diff, [{ hunk: 0 }]), 'a\nb\nc\nd\ne\nf\nG\nG2\nh\n');
    assert.equal(revertLines(after, diff, [{ hunk: 1 }]), 'a\nB\nc\nd\ne\nf\ng\nh\n');
    assert.equal(revertLines(after, diff, [{ hunk: 0 }, { hunk: 1 }]), before);
  });

  test('**行を押すと、その行を含む書き換えの組を丸ごと戻す**（片方だけ戻して両方が並ぶ姿を作らない）', () => {
    const { revertLines, splitHunks } = hunksApi;
    const h1 = splitHunks(diff)[1]!;
    // 2 つ目の塊は「-g / +G / +G2」。どの行を押しても、g に戻り G と G2 は消える。
    for (const text of ['+G2', '+G', '-g']) {
      const at = h1.lines.findIndex((l) => l === text);
      assert.ok(at >= 0, h1.lines.join('|'));
      assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [at] }]), 'a\nB\nc\nd\ne\nf\ng\nh\n', `${text} を押したとき`);
    }
  });

  test('一つの塊に書き換えの組が二つあれば、押した方の組だけ戻す', () => {
    const { revertLines, splitHunks } = hunksApi;
    const b2 = 'a\nb\nc\nd\n';
    const a2 = 'A\nb\nC\nd\n';
    const d2 = unifiedDiff('y.txt', b2, a2, 3);
    const h = splitHunks(d2);
    assert.equal(h.length, 1, d2);
    const atC = h[0]!.lines.indexOf('+C');
    assert.equal(revertLines(a2, d2, [{ hunk: 0, lines: [atC] }]), 'A\nb\nc\nd\n');
    // 変えていない行（文脈）を押しても何も戻さない。
    const atB = h[0]!.lines.indexOf(' b');
    assert.equal(revertLines(a2, d2, [{ hunk: 0, lines: [atB] }]), a2);
  });

  test('その後に変わっていれば、当てない（壊さない）', () => {
    const { revertLines } = hunksApi;
    assert.equal(revertLines(after.replace('G2', 'changed'), diff, [{ hunk: 1 }]), undefined);
    assert.equal(revertLines(after, diff, [{ hunk: 5 }]), undefined);
    assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [99] }]), undefined);
    // 整数でない番号（画面以外の口から来る）は当てない。落ちもしない。
    assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [1.5] }]), undefined);
  });

  test('新しく作ったファイルを全部戻すと、空になる', () => {
    const { revertLines } = hunksApi;
    const made = unifiedDiff('n.txt', '', 'x\ny\n');
    assert.equal(revertLines('x\ny\n', made, [{ hunk: 0 }]), '');
  });
});
