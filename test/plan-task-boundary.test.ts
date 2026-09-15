/**
 * 段取りも、依頼ごとに履歴を切る。
 *
 * ハーネスの規則は「1つの依頼の中での積み重ね」を見る。送り口（send）は
 * 頼まれた時点で `beginTask()` を呼んで履歴を切っていたが、
 * **段取り（plan）は一度も呼んでいなかった。**
 *
 * 切らないと、前の依頼で書いたファイルが今回の分として数えられる。
 * 上限（maxFilesPerTask）まで書いたあとは、**一文字も書いていない依頼が
 * 最初の一回で止まる。**画面には「書き換えました」と出ない代わりに
 * 「1つの依頼で書き換えられるのは N 件までです」だけが出るので、
 * 直しに行く先が出ない。同じ内容の書き直しを止める規則も同じように誤爆する。
 *
 * ここで見るのは規則の側ではなく、**依頼の切れ目**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-plan-boundary-');
const { Session } = await import('../src/core/session.ts');

const ctxAt = (root: string): ToolContext =>
  ({ root, signal: new AbortController().signal, approve: async () => true });

/**
 * 書き換えの上限を 1 件にしたセッション。
 *
 * 段取りは分解でモデルを呼ぶ。JSON を返さない相手でよい
 * （読めなければ割らずに進む形に落ちる）。本物のモデルは要らない。
 */
async function opened() {
  const fake = await startFakeServer({ kind: 'stream', text: 'JSON ではない返事' });
  const root = await tempDir('aas-plan-boundary-root-');
  const session = await Session.create({
    providers: [{
      id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'],
    }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 1 },
    harness: { maxFilesPerTask: 1 },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  return { session, root, fake };
}

describe('段取りは、依頼の切れ目で履歴を切る', () => {
  test('**前の依頼で書いた分を、今回の分として数えない**', async () => {
    const { session, root, fake } = await opened();
    try {
      const write = session.toolPool.write.find((t) => t.schema.name === 'write_file');
      assert.ok(write, '書き込みのツールが無い');
      const ctx = ctxAt(root);

      // 1 件目は通る。
      const first = await write.run({ path: 'a.txt', content: 'a' }, ctx);
      assert.ok(!first.isError, `1 件目が通らない: ${first.content}`);

      // 2 件目は止まる。**上限が効いていることの対。**
      const second = await write.run({ path: 'b.txt', content: 'b' }, ctx);
      assert.equal(second.isError, true, `上限が効いていない: ${second.content}`);
      assert.match(second.content, /BLOCKED by blast-radius/);

      // 段取りを頼む。ここが新しい依頼の始まり。
      const seen: string[] = [];
      for await (const ev of session.plan('b.txt を作って')) seen.push(ev.type);
      // **本当に段取りが走ったことを見る。**断られて即座に返っていたら、
      // 履歴が切れたのは段取りのせいではない（この試験が何も見ていないことになる）。
      assert.ok(seen.includes('planned'), `段取りが走っていない: ${seen.join(',')}`);
      assert.ok(seen.includes('accepted'), `検収まで行っていない: ${seen.join(',')}`);

      // 新しい依頼の 1 件目として通る。
      const third = await write.run({ path: 'b.txt', content: 'b' }, ctx);
      assert.ok(!third.isError, `新しい依頼なのに止められた: ${third.content}`);
      assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b', '通ったのに書けていない');
    } finally {
      await session.close();
      await fake.close();
    }
  });
});
