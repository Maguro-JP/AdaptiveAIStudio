/**
 * 置き場の決まりを、勝手に読むところの検査。
 *
 * 頼むたびに人が貼り直す形だと、貼り忘れた回だけ決まりが効かない。
 * **置いてあれば効く**ことを、ここで留める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import {
  readProjectRules, fitRules, rulesBlock, ProjectRules, RULE_FILES,
} from '../src/agent/project-rules.ts';
import { estimateTokens } from '../src/agent/window.ts';

describe('置き場の決まりを読む', () => {
  test('無いのが普通。黙って空を返す', async () => {
    const dir = await tempDir('aas-rules-none-');
    assert.deepEqual(await readProjectRules(dir), []);
    assert.equal(rulesBlock([]), '', '無いのに何か書いている');
  });

  test('世の中で使われている名前を、そのまま拾う', async () => {
    const dir = await tempDir('aas-rules-names-');
    for (const name of RULE_FILES) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `${name} の中身`);
    }
    const got = await readProjectRules(dir);
    assert.deepEqual(got.map((r) => r.path), [...RULE_FILES], '拾えていない名前がある');
  });

  test('Cursor の置き場（.cursor/rules）も、名前順に読む', async () => {
    const dir = await tempDir('aas-rules-cursor-');
    await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(dir, '.cursor', 'rules', 'b.mdc'), 'ふたつめ');
    await writeFile(join(dir, '.cursor', 'rules', 'a.md'), 'ひとつめ');
    await writeFile(join(dir, '.cursor', 'rules', 'メモ.txt'), '決まりではない');
    const got = await readProjectRules(dir);
    assert.deepEqual(got.map((r) => r.path), ['.cursor/rules/a.md', '.cursor/rules/b.mdc']);
  });

  test('空のファイルは、決まりとして数えない', async () => {
    const dir = await tempDir('aas-rules-empty-');
    await writeFile(join(dir, 'AGENTS.md'), '   \n\n');
    assert.deepEqual(await readProjectRules(dir), []);
  });

  test('どこから来た文かを書く', async () => {
    const block = rulesBlock([{ path: 'AGENTS.md', text: '日本語で書く', at: 0 }]);
    assert.ok(block.includes('AGENTS.md'), '出どころが分からない');
    assert.ok(block.includes('日本語で書く'));
    // **決まりであって、許可ではない。**
    assert.ok(block.includes('許可ではありません'), '権限の話が抜けている');
  });

  test('窓に合わせて切る。切ったことは隠さない', () => {
    const long = { path: 'CLAUDE.md', text: Array.from({ length: 500 }, (_, i) => `決まり${i}`).join('\n'), at: 0 };
    const budget = 200;
    const fit = fitRules([long], budget);
    assert.equal(fit.length, 1);
    assert.ok(estimateTokens(fit[0]!.text) <= budget + 20, `窓を超えている: ${estimateTokens(fit[0]!.text)}`);
    assert.ok(fit[0]!.text.includes('ここまで'), '切ったことを言っていない');
    // 行の途中では切らない。
    assert.ok(!/決まり\d+[^\d\n]/.test(fit[0]!.text.replace('\n…（長いので、ここまで）', '')), '行の途中で切れている');
  });

  test('入り切らないものは載せない。入るものは全部載せる', () => {
    const a = { path: 'a', text: 'あ'.repeat(10), at: 0 };
    const b = { path: 'b', text: 'い'.repeat(10), at: 0 };
    assert.deepEqual(fitRules([a, b], 100).map((r) => r.path), ['a', 'b']);
    assert.deepEqual(fitRules([a, b], 0).map((r) => r.path), []);
  });

  test('直したら効く。読み直しの間隔は超えて確かめる', async () => {
    const dir = await tempDir('aas-rules-fresh-');
    await writeFile(join(dir, 'AGENTS.md'), '前の決まり');
    const rules = new ProjectRules(dir, 1_000);
    const at = 1_000_000;
    assert.ok((await rules.block(1000, at)).includes('前の決まり'));

    await writeFile(join(dir, 'AGENTS.md'), '後の決まり');
    // 間隔の内は、前に読んだものをそのまま使う（毎回ディスクを見に行かない）。
    assert.ok((await rules.block(1000, at + 100)).includes('前の決まり'), '毎回読み直している');
    // 間隔を過ぎたら、直したものが効く。
    assert.ok((await rules.block(1000, at + 2_000)).includes('後の決まり'), '直しても効かない');
  });
});

/**
 * 置いただけで効くか、**実際に一往復させて確かめる。**
 *
 * 読めることと、モデルの手元に届くことは別。届いていなければ、
 * 置き場に決まりを書いた人から見て「読んでいない」のと同じ。
 */
describe('置いただけで、モデルに届く', () => {
  test('AGENTS.md の中身が、決まりとして渡っている', async () => {
    const { startFakeServer } = await import('./fake-server.ts');
    const { Session } = await import('../src/core/session.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');

    const root = await tempDir('aas-rules-e2e-');
    await writeFile(join(root, 'AGENTS.md'), 'この置き場では、変数名を kebab-case にすること。');
    const fake = await startFakeServer({ kind: 'stream', text: 'わかりました。' });
    try {
      const session = await Session.create({
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        agent: { root, approval: 'auto' },
      } as never, { approve: () => Promise.resolve(true) });
      for await (const _ of session.send('こんにちは')) { /* 流し切る */ }

      const sent = JSON.stringify(fake.bodies);
      assert.ok(sent.includes('kebab-case'), '置き場の決まりが渡っていない');
      assert.ok(sent.includes('AGENTS.md'), 'どこから来た文か渡っていない');
    } finally { await fake.close(); }
  });
});

describe('渡された取り分を、超えない', () => {
  /**
   * 見出し・区切り・締めの二文で 100 前後ある。中身だけ数えていたので、
   * **132 と渡されて 237 返していた**（実測）。渡した側は残りが在ると思って
   * 次を組むので、後ろに置いたもの（作業場の地図）が、どの窓でも丸ごと
   * 落ちていた。**超えたことは誰にも見えない**のが、この形のたちの悪さ。
   */
  test('**囲みを入れても、渡された分に収まる**', async () => {
    const root = await tempDir('aas-rules-budget-');
    await writeFile(join(root, 'AGENTS.md'), `${'この置き場の決まり。\n'.repeat(200)}`, 'utf8');
    const rules = new ProjectRules(root);

    for (const budget of [40, 132, 400, 1200]) {
      const block = await rules.block(budget);
      assert.ok(estimateTokens(block) <= budget,
        `取り分 ${budget} に対して ${estimateTokens(block)} 返している`);
    }
  });

  test('取り分が 0 なら、何も返さない', async () => {
    const root = await tempDir('aas-rules-zero-');
    await writeFile(join(root, 'AGENTS.md'), '決まり\n', 'utf8');
    assert.equal(await new ProjectRules(root).block(0), '');
  });
});
