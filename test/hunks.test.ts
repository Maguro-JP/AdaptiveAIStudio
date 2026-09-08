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
import { unifiedDiff } from '../src/agent/diff.ts';
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
  // 終わりの改行の有無だけの違いは、行の違いとしては出ない（承認に出す用なので、それでよい）。
  assert.equal(unifiedDiff('a.txt', 'x', 'x\n'), '');
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

  test('**行ごとに戻す**（塊の中の一行だけ）', () => {
    const { revertLines, splitHunks } = hunksApi;
    const h1 = splitHunks(diff)[1]!;
    // 2 つ目の塊は「-g / +G / +G2」。G2 だけ戻す。
    const g2 = h1.lines.findIndex((l) => l === '+G2');
    assert.ok(g2 >= 0, h1.lines.join('|'));
    assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [g2] }]), 'a\nB\nc\nd\ne\nf\nG\nh\n');
    // -g だけ戻す（g を復活させ、G と G2 は残る）。
    const g = h1.lines.findIndex((l) => l === '-g');
    assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [g] }]), 'a\nB\nc\nd\ne\nf\ng\nG\nG2\nh\n');
  });

  test('その後に変わっていれば、当てない（壊さない）', () => {
    const { revertLines } = hunksApi;
    assert.equal(revertLines(after.replace('G2', 'changed'), diff, [{ hunk: 1 }]), undefined);
    assert.equal(revertLines(after, diff, [{ hunk: 5 }]), undefined);
    assert.equal(revertLines(after, diff, [{ hunk: 1, lines: [99] }]), undefined);
  });

  test('新しく作ったファイルを全部戻すと、空になる', () => {
    const { revertLines } = hunksApi;
    const made = unifiedDiff('n.txt', '', 'x\ny\n');
    assert.equal(revertLines('x\ny\n', made, [{ hunk: 0 }]), '');
  });
});
