/**
 * repo map の取り分と、selftest の言い分けの不具合（56 回目の調査）。
 *
 * - 入り切らない repo map の但し書きを数えずに足し、取り分を超えて、システムプロンプトの組み立てで repo map が丸ごと落ちた
 * - システムプロンプトの部品の間の区切りを数えず、詰め切った回は全体が予算を超え、低い部品が落ちた
 * - 依頼に `index.ts` と書くと、`code-index.ts` まで強い seed にしていた
 * - node-llama-cpp の依存が欠けた壊れ方を「入っていません」と言った。モデルの保存先が読めないのを「ありません」と言った
 *
 * 作ってある repo map を今回の取り分と比べずに使い回していた件（`src/core/session.ts` の `#repoMap`）は、試験を書いていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { buildIndex } from '../src/agent/code-index.ts';
import { rankedEntries, seedFrom, renderMap } from '../src/agent/repo-map.ts';
import { fitParts } from '../src/core/prompt-budget.ts';
import { llamaLoadVerdict, modelsDirProblem } from '../src/cli/selftest-reasons.ts';

describe('repo map の取り分', () => {
  test('**入り切らないときも、但し書きを含めて取り分に収める**', async () => {
    const root = await tempDir('aas-map-budget-');
    await mkdir(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 40; i++) {
      await writeFile(join(root, 'src', `f${i}.ts`), `export function name${i}() { return ${i}; }\n`);
    }
    const index = await buildIndex(root);
    for (const chars of [150, 300, 600]) {
      const map = renderMap(rankedEntries(index), { chars });
      assert.match(map, /載せていません/, '前提: 入り切っている');
      assert.ok(map.length <= chars, `取り分 ${chars} を超えた: ${map.length}`);
    }
  });

  test('**部品の間の区切りも予算に入れる**', async () => {
    const fill = (name: string, priority: number) => ({ name, priority, render: (give: number) => 'x'.repeat(give) });
    const { text, dropped } = await fitParts([fill('上', 30), fill('中', 20), fill('repo map', 10)].map((p, i) => i < 2 ? { ...p, atMost: 30 } : p), 100, (t) => t.length);
    assert.deepEqual(dropped, [], `詰め切った部品を落とした: ${dropped.join(',')}`);
    assert.ok(text.length <= 100, `予算を超えた: ${text.length}`);
  });

  test('**ファイル名は区切りの境目で当てる**', async () => {
    const root = await tempDir('aas-map-seed-');
    await mkdir(join(root, 'src', 'agent'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export function main() { return 1; }\n');
    await writeFile(join(root, 'src', 'agent', 'code-index.ts'), 'export function build() { return 2; }\n');
    const index = await buildIndex(root);
    const seed = seedFrom(index, 'index.ts を直して', [], [], { search: false });
    const at = (p: string) => seed.get(index.files.findIndex((f) => f.path === p)) ?? 0;
    assert.ok(at('src/index.ts') >= 3, '言われたファイルを seed にしていない');
    assert.ok(at('src/agent/code-index.ts') < 3, '名前の末尾が同じだけの別のファイルを、強い seed にした');
  });
});

describe('selftest の言い分け', () => {
  test('**依存が欠けた形は「入っていない」と言わない**', () => {
    const missing = Object.assign(new Error("Cannot find package 'node-llama-cpp' imported from /app/src/cli/selftest.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    const brokenDep = Object.assign(new Error("Cannot find package 'lifecycle-utils' imported from /app/node_modules/node-llama-cpp/dist/index.js"), { code: 'ERR_MODULE_NOT_FOUND' });
    assert.equal(llamaLoadVerdict(missing), undefined);
    assert.equal(llamaLoadVerdict(brokenDep), false, '依存の欠けを「入っていない」とした');
  });

  test('**読めない保存先を「ありません」と言わない**', () => {
    assert.match(modelsDirProblem(Object.assign(new Error('x'), { code: 'ENOENT' }), 'Z:\\models'), /ありません/);
    assert.doesNotMatch(modelsDirProblem(Object.assign(new Error('x'), { code: 'EACCES' }), 'Z:\\models'), /ありません/);
  });
});
