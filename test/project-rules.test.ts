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
  readProjectRules, fitRules, fitRulesWithDropped, rulesBlock, ProjectRules, RULE_FILES,
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
    await writeFile(join(root, 'AGENTS.md'), 'このリポジトリでは、変数名を kebab-case にすること。');
    const fake = await startFakeServer({ kind: 'stream', text: 'わかりました。' });
    try {
      const session = await Session.create({
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        agent: { root, approval: 'auto' },
      } as never, { approve: () => Promise.resolve(true) });
      // **作業の依頼で見る。**挨拶は問いかけとして扱われ、リポジトリの決まりを
      // 載せない（下の対の試験で押さえている）。
      for await (const _ of session.send('src/a.ts を直して')) { /* 流し切る */ }

      const sent = JSON.stringify(fake.bodies);
      assert.ok(sent.includes('kebab-case'), '置き場の決まりが渡っていない');
      assert.ok(sent.includes('AGENTS.md'), 'どこから来た文か渡っていない');
    } finally { await fake.close(); }
  });

  /**
   * 訊かれただけのときに、リポジトリの決まりまで載せない（対）。
   *
   * 役職はどれも作業の役職で、話し相手が一人もいなかった。だから
   * 「明日の天気は？」にも作業者の決まりとリポジトリの決まりとツールの説明が載り、
   * 2B の模型は問いをなぞって「完了」と返した（実機）。
   */
  test('**訊かれただけのときは、リポジトリの決まりを載せない**', async () => {
    const { startFakeServer } = await import('./fake-server.ts');
    const { Session } = await import('../src/core/session.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');

    const root = await tempDir('aas-rules-chat-');
    await writeFile(join(root, 'AGENTS.md'), 'このリポジトリでは、変数名を kebab-case にすること。');
    const fake = await startFakeServer({ kind: 'stream', text: '2 です。' });
    try {
      const session = await Session.create({
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        agent: { root, approval: 'auto' },
      } as never, { approve: () => Promise.resolve(true) });
      for await (const _ of session.send('1+1=')) { /* 流し切る */ }

      const asked = (fake.bodies as { messages?: { role: string; content: string }[]; tools?: unknown[] }[])
        .filter((b) => (b.messages ?? []).some((m) => m.role === 'user' && m.content.includes('1+1=')));
      assert.ok(asked.length > 0, 'その依頼を送っていない');
      const sent = JSON.stringify(asked);
      assert.ok(!sent.includes('kebab-case'), '問いかけにリポジトリの決まりを載せている');
      assert.ok(!sent.includes('AGENTS.md'), '問いかけにリポジトリの名前を載せている');
      assert.equal(asked.at(-1)!.tools?.length ?? 0, 0, '問いかけにツールを載せている');
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

/**
 * 決まりがコンテキストウィンドウに入らないとき、**どこまで渡ったかを分かるようにする。**
 *
 * ここは行の切れ目で頭から詰めるだけだった。`## ` の見出しを跨いで切るので、
 * **途中の節が半分だけ渡り、その後ろは丸ごと消える。**残るのは
 * 「…（長いので、ここまで）」の一行だけで、何が消えたかは誰にも分からない。
 *
 * この CLAUDE.md（11 節）で実測すると、コンテキストウィンドウ 8192 では 2 節しか渡っていない。
 * 「push では CI を回さない」も「C: 直下にフォルダを作らない」も、
 * **一度もモデルに届いていなかった。**
 */
describe('入り切らない決まりを、名前で返す', () => {
  const rule = (text: string) => [{ path: 'CLAUDE.md', text, at: 0 }];
  const doc = [
    '# 見出し',
    '',
    '## さいしょ',
    'あ'.repeat(100),
    '',
    '## つぎ',
    'い'.repeat(100),
    '',
    '## さいご',
    'う'.repeat(100),
  ].join('\n');
  // 文字数ではなく、その場で数えた値で比べる（見積もりの係数に依らない）。
  const chars = (t: string): number => t.length;

  test('**入るものは入り、入らないものは名前で返る**', () => {
    const got = fitRulesWithDropped(rule(doc), 200, chars);
    assert.equal(got.kept.length, 1, '何も入っていない');
    assert.ok(got.kept[0]!.text.includes('さいしょ'), '頭から入っていない');
    assert.ok(got.dropped.length > 0, '落としたのに、何も言っていない');
    assert.ok(got.dropped.some((d) => d.includes('さいご')), `名前が出ていない: ${got.dropped.join(',')}`);
  });

  test('**節の途中で切らない**', () => {
    // 半分だけ渡ると、決まりが逆の意味になることがある。
    const got = fitRulesWithDropped(rule(doc), 200, chars);
    const text = got.kept[0]?.text ?? '';
    for (const head of ['さいしょ', 'つぎ', 'さいご']) {
      if (!text.includes(head)) continue;
      assert.ok(text.includes('あ'.repeat(100)) || !text.includes('## さいしょ'),
        '見出しだけ入って中身が切れている');
    }
    assert.ok(!text.includes('（長いので、ここまで）'), '途中で切っている');
  });

  test('**上から順に入れる。小さい節を先に入れない**', () => {
    /*
     * 一度、入らない節を飛ばして次を試す形にした。予算は埋まるが、
     * 大きくて大事な節が落ち、小さくてどうでもいい節が入る。
     * 実際にコンテキストウィンドウ 4096 で「## 前提（勝手に変えない）」が落ちて「## 時刻」が入った。
     * 書いた人は大事なものを上に置くので、並びを崩す方が悪い。
     */
    const uneven = ['# 見出し', '', '## おおきい', 'あ'.repeat(300), '', '## ちいさい', 'い'].join('\n');
    const got = fitRulesWithDropped(rule(uneven), 120, chars);
    const text = got.kept[0]?.text ?? '';
    assert.ok(!text.includes('ちいさい'),
      `大きい節を飛ばして、小さい節を入れている: ${JSON.stringify(text)}`);
  });

  test('全部入るなら、何も落とさない（対）', () => {
    const got = fitRulesWithDropped(rule(doc), 10_000, chars);
    assert.deepEqual(got.dropped, []);
    assert.equal(got.kept.length, 1);
    assert.ok(got.kept[0]!.text.includes('さいご'), '全部入るはずが入っていない');
  });

  test('`fitRules` は今までどおり返す（対）', () => {
    // 呼んでいる側を壊さない。
    const got = fitRules(rule(doc), 10_000, chars);
    assert.equal(got.length, 1);
    assert.ok(got[0]!.text.includes('さいご'));
  });
});
