/**
 * 作業場の索引 — **コードを見つけられるようにする。**
 *
 * 探す道具が `search_text`（完全一致の grep）だけだった。
 * 名前が分かっているなら足りるが、**分かっていないときに何も出ない。**
 * 人は「設定を保存している所」と訊く。小さいモデルもそう書く。
 * そこで力尽きるので、直すところまで辿り着かない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import {
  buildIndex, searchIndex, terms, symbolsIn, digestOf, IndexStore,
} from '../src/agent/code-index.ts';

/** 小さな作業場を作る。**注釈に意図を書く**（本物と同じ形）。 */
async function repo(): Promise<string> {
  const root = await tempDir('aas-ix-');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'junk', 'a.ts'), 'export function 会話(){}');
  await writeFile(join(root, 'src', 'conversations.ts'),
    '/**\n * 会話を残す。\n * 会話は一つのファイルに一つ。会話を読み直せる。\n */\n'
    + 'export function saveConversation(x: string) { return x; }\n'
    + 'export class Conversations { load() {} }\n');
  await writeFile(join(root, 'src', 'settings.ts'),
    '/** 置き場所の設定。 */\nexport function saveRuntime() {}\n');
  await writeFile(join(root, 'README.md'),
    '# 説明\n会話を残す仕組みと、会話の読み直しについて。会話。会話。\n');
  await writeFile(join(root, 'big.ts'), 'x'.repeat(500_000));
  return root;
}

describe('索引を作る', () => {
  test('名前と、その行を拾う', async () => {
    const ix = await buildIndex(await repo());
    const conv = ix.files.find((f) => f.path === 'src/conversations.ts')!;
    assert.ok(conv, '索引に入っていない');
    const names = conv.symbols.map((s) => s.name);
    assert.ok(names.includes('saveConversation'), names.join(','));
    assert.ok(names.includes('Conversations'), names.join(','));
    // 行まで持つこと。**どこに在るかまで返せないと、開き直しになる。**
    assert.ok(conv.symbols.find((s) => s.name === 'saveConversation')!.line > 0);
  });

  test('見に行かない場所は入れない', async () => {
    const ix = await buildIndex(await repo());
    assert.ok(!ix.files.some((f) => f.path.includes('node_modules')), 'node_modules を入れている');
  });

  test('大きすぎるものは入れず、数える', async () => {
    const ix = await buildIndex(await repo());
    assert.ok(!ix.files.some((f) => f.path === 'big.ts'));
    assert.ok(ix.skipped > 0, '落としたのに数えていない');
  });

  test('意図は注釈に書いてある。注釈を索引に持つ', async () => {
    const d = digestOf('/**\n * 会話を残す。\n */\nconst x = 1;\n// 途中の注釈もここに入る\n');
    assert.match(d, /会話を残す/);
    assert.match(d, /途中の注釈/);
  });
});

describe('言葉を割る', () => {
  test('日本語はひらがなで切る', () => {
    // 助詞と語尾はひらがな。意味を持つのは漢字とカタカナ。
    const t = terms('設定を保存している所');
    assert.ok(t.includes('設定'), t.join(','));
    assert.ok(t.includes('保存'), t.join(','));
  });

  test('camelCase も割る', () => {
    const t = terms('saveConversation');
    assert.ok(t.includes('save') && t.includes('conversation'), t.join(','));
  });

  test('二文字の連なりが無いときだけ、一文字も採る', () => {
    // 「道の長さ」で何も取れないと、探しようがない。
    assert.ok(terms('道の長さ').includes('道'));
    // 取れているときは、一文字を混ぜない（雑音になる）。
    assert.ok(!terms('設定を保存').includes('設'));
  });

  test('名前を一行から拾う', () => {
    assert.deepEqual(symbolsIn('export async function doIt(a) {'), ['doIt']);
    assert.deepEqual(symbolsIn('export class Foo {'), ['Foo']);
    assert.deepEqual(symbolsIn('def handle_request(self):'), ['handle_request']);
    assert.deepEqual(symbolsIn('func Serve(w http.ResponseWriter) {'), ['Serve']);
    assert.deepEqual(symbolsIn('if (x) {'), []);
  });
});

describe('当てる', () => {
  test('名前で当てる', async () => {
    const root = await repo();
    const hits = await searchIndex(await buildIndex(root), 'saveConversation', { limit: 3 });
    assert.equal(hits[0]?.path, 'src/conversations.ts', JSON.stringify(hits.map((h) => h.path)));
    assert.ok(hits[0]!.symbols.some((s) => s.name === 'saveConversation'), '名前を返していない');
  });

  test('日本語の意図で当てる（名前が分からなくても）', async () => {
    // **ここが要点。**grep では何も出ない問い。
    const root = await repo();
    const hits = await searchIndex(await buildIndex(root), '会話を残すところ', { limit: 3 });
    assert.equal(hits[0]?.path, 'src/conversations.ts', JSON.stringify(hits.map((h) => `${h.path}:${h.score}`)));
  });

  test('散文より、コードを上に出す', async () => {
    // README も当たるが、直す先はコードの方。
    const root = await repo();
    const hits = await searchIndex(await buildIndex(root), '会話', { limit: 5 });
    const code = hits.findIndex((h) => h.path.endsWith('.ts'));
    const doc = hits.findIndex((h) => h.path.endsWith('.md'));
    assert.ok(code >= 0, 'コードが出ていない');
    assert.ok(doc < 0 || code < doc, `散文が上に来ている: ${hits.map((h) => h.path).join(',')}`);
  });

  test('当たった行だけを返す。丸ごとは返さない', async () => {
    // 丸ごと返すと、それだけで窓が埋まる。
    const root = await repo();
    const hits = await searchIndex(await buildIndex(root), '会話', { limit: 2 });
    for (const h of hits) assert.ok(h.lines.length <= 4, `行を返しすぎ: ${h.lines.length}`);
  });

  test('当たらなければ、空で返す（作り話をしない）', async () => {
    const hits = await searchIndex(await buildIndex(await repo()), 'そんな言葉はどこにも無い', { limit: 3 });
    assert.deepEqual(hits, []);
  });
});

describe('索引を覚える', () => {
  test('置き場に残り、読み直せる', async () => {
    const root = await repo();
    const dir = join(await tempDir('aas-ixs-'), 'index');
    const store = new IndexStore(dir);
    const made = await store.fresh(root);
    assert.ok(made.files.length > 0);
    // 別の器から読み直しても在ること。
    assert.ok((await new IndexStore(dir).load(root))!.files.length === made.files.length);
    // 別の作業場のものは返さない。
    assert.equal(await new IndexStore(dir).load('/そんな場所'), undefined);
  });
});

/**
 * 索引に入っていないものを、「無い」と言わない。
 *
 * 大きな置き場では上限（4000 ファイル）で切る。切ること自体はよいが、
 * **黙って切ると、入っていないものが「無い」と返る。**無いと言われた側は
 * コードが無いのだと思って、別のやり方を探しはじめる。
 * **静かに間違った答えを返すのが、いちばん悪い。**
 */
describe('切ったことを、黙らない', () => {
  async function tree(count: number): Promise<string> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await tempDir('aas-capped-');
    for (let i = 0; i < count; i += 1) {
      const sub = join(root, `p${Math.floor(i / 20)}`);
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, `f${i}.ts`), `export function thing${i}() { return ${i}; }\n`);
    }
    return root;
  }

  test('上限に当たったら、あと何件あるかを言う', async () => {
    const root = await tree(60);
    const index = await buildIndex(root, 40);
    assert.equal(index.files.length, 40);
    assert.equal(index.capped, 20, `あと何件あるかを言っていない: ${index.capped}`);
  });

  test('全部入るなら、何も言わない（対）', async () => {
    const root = await tree(10);
    const index = await buildIndex(root, 40);
    assert.equal(index.capped, undefined, '切っていないのに言っている');
  });

  test('**探す道具が、そのことを返事に書く**', async () => {
    const { IndexStore } = await import('../src/agent/code-index.ts');
    const root = await tree(60);
    const index = await buildIndex(root, 40);

    // 道具は記録の置き場から控えを引く。**そこへ置いてから呼ぶ。**
    // （本物の上限は 4000。試験で 4000 ファイル作るのは高いので、
    //   切れた索引を先に置いて、同じ道を通す）
    const state = await tempDir('aas-capped-state-');
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = state;
    try {
      await new IndexStore(join(state, 'index')).save(index);
      const { findCodeTool } = await import('../src/agent/tools/find.ts');

      // 見つかったときも、見つからなかったときも言う。
      for (const query of ['thing1', 'まったく関係のない言葉']) {
        const got = await findCodeTool.run(
          { query },
          { root, signal: new AbortController().signal, approve: () => Promise.resolve(true) } as never,
        );
        assert.ok(
          got.content.includes('あと 20 ファイル'),
          `切ったことを言っていない（${query}）: ${got.content.slice(0, 200)}`,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.AAS_STATE_DIR;
      else process.env.AAS_STATE_DIR = prev;
    }
  });
});
