/**
 * 終わらなかった作業を、こちらから拾って続ける。
 *
 * **これが「自律的に進める」の中身。**控えるだけでは、人が言い直すまで
 * 動かない。手が空いた時点で、こちらから始めること。
 *
 * ここでは、**人が一度も言い直していないこと**を見る。
 * 送るのは最初の一度だけ。そのあとは誰も何も言わない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

// 置き場は**試験ごとに分ける**。共有すると、前の試験の控えと会話が
// 残ったまま次が走り、一緒に走らせたときだけ落ちる。
const dir = await tempDir('aas-resume-');
process.env.AAS_STATE_DIR = dir;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { UnfinishedWork } = await import('../src/core/unfinished.ts');

/**
 * 偽モデルは、**試験ごとに一つ**。
 *
 * 一つを取り合うと、前の試験の続きが走っている最中に振る舞いを変えられ、
 * 一緒に走らせたときだけ落ちる。走らせる場所で結果が変わる試験は書かない。
 */
/** この試験だけの置き場に切り替える。**器を作る前に呼ぶ。** */
async function ownState(name: string): Promise<string> {
  const d = await tempDir(`aas-resume-${name}-`);
  process.env.AAS_STATE_DIR = d;
  return d;
}

function config(fake: FakeServer, root: string) {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['p:m'],
    agent: { root, approval: 'auto' },
  } as typeof DEFAULT_CONFIG;
}

/**
 * 依頼を一つ流し切る。**言い直すのは、ここ一度きり。**
 *
 * 待つのは「何か控えられた」ではなく「**この依頼が**控えられた」。
 * 前の試験の控えが残っていると、待たずに通り過ぎる。
 */
async function ask(base: string, text: string): Promise<{ id: string }> {
  const r = await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  assert.equal(r.status, 202, await r.text());
  for (let i = 0; i < 300; i += 1) {
    const info = await (await fetch(`${base}/api/unfinished`)).json() as {
      list: { id: string; request: string }[];
    };
    const mine = info.list.find((u) => u.request === text);
    if (mine) return mine;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error(`控えられませんでした: ${text}`);
}

describe('やり残しを、こちらから拾う', () => {
  test('途中で止まった依頼が控えに残り、暇なときに続きが始まる', async () => {
    const state = await ownState('a');
    const root = await tempDir('aas-resume-root-');
    // **道具を使ってから、合図なしで止まる。**押し戻しても動かない形。
    // 実際にローカルの小さいモデルがする止まり方。
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'では、このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const mine = await ask(base, 'src を直して');

      // 控えに残っていること。**人はまだ何も言い直していない。**
      const first = await (await fetch(`${base}/api/unfinished`)).json() as {
        list: { id: string; request: string; why: string; attempts: number }[];
      };
      const got = first.list.find((u) => u.id === mine.id)!;
      assert.ok(got, `控えていない: ${JSON.stringify(first)}`);
      assert.equal(got.request, 'src を直して');
      assert.equal(got.why, 'noProgress');

      // すぐには戻らない。手が空いていても、間を置く。
      const session = await s.session();
      assert.notEqual(await s.idleTick(session), 'RESUMED', 'すぐ戻している');

      // 時が来たことにする（控えの時刻を過去にする）。
      const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
      await store.bump(mine.id, Date.now() - 60 * 60_000);

      // 今度は素直に終わる形にしておく。
      fake.setBehavior({ kind: 'stream', text: '直しました。' });

      // **ここが要点。人は何も言っていない。**手が空いたので、こちらから始める。
      assert.equal(await s.idleTick(session), 'RESUMED', 'こちらから続きを始めていない');

      // 続きが終わって、控えが片づくまで待つ。
      for (let i = 0; i < 300; i += 1) {
        const now = await (await fetch(`${base}/api/unfinished`)).json() as { list: { id: string }[] };
        if (!now.list.some((u) => u.id === mine.id)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail('続きが終わっても控えが片づかない');
    } finally { await s.stop(); await fake.close(); }
  });

  test('利用者は、やめられる', async () => {
    // **見えて、やめられること。**知らないうちに勝手に動き続けるのが
    // いちばん怖い。
    await ownState('b');
    const root = await tempDir('aas-resume-root2-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const { id } = await ask(base, 'docs を直して');
      const del = await fetch(`${base}/api/unfinished?id=${id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      const after = await (await fetch(`${base}/api/unfinished`)).json() as { list: { id: string }[] };
      assert.ok(!after.list.some((u) => u.id === id), 'やめたのに残っている');
    } finally { await s.stop(); await fake.close(); }
  });

  test('片づいた依頼は、控えない（対）', async () => {
    // 何でも控えると、終わったものまで蒸し返して回り続ける。
    await ownState('c');
    const root = await tempDir('aas-resume-root3-');
    const fake = await startFakeServer({ kind: 'stream', text: '説明しました。' });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const before = (await (await fetch(`${base}/api/unfinished`)).json() as { list: unknown[] }).list.length;
      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'この関数は何ですか' }),
      });
      await new Promise((r) => setTimeout(r, 1500));
      const after = (await (await fetch(`${base}/api/unfinished`)).json() as { list: unknown[] }).list.length;
      assert.equal(after, before, '終わったものまで控えている');
    } finally { await s.stop(); await fake.close(); }
  });
});

describe('思いつきを切っても、頼まれたことは放り出さない', () => {
  test('initiative を切っても、やり残しは拾う', async () => {
    // 「勝手に考え始めないでほしい」と「頼んだことを途中で放り出してよい」は
    // まったく別の話。ここを一つの栓にしていたので、思いつきを切った人は
    // やり残しの拾い上げごと失っていた。
    const state = await ownState('d');
    const root = await tempDir('aas-resume-root4-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' }, then: 'このあと直します。',
    });
    const s = new UiServer({
      config: { ...config(fake, root), initiative: { enabled: false } },
      port: 0,
    });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const mine = await ask(base, 'test を直して');
      const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
      await store.bump(mine.id, Date.now() - 60 * 60_000);
      fake.setBehavior({ kind: 'stream', text: '直しました。' });
      const session = await s.session();
      assert.equal(await s.idleTick(session), 'RESUMED', '思いつきを切ると、やり残しまで止まる');
    } finally { await s.stop(); await fake.close(); }
  });

  test('思いつきの方は、切れている（対）', async () => {
    // 切ったのに考え始めるなら、切れていない。
    await ownState('e');
    const root = await tempDir('aas-resume-root5-');
    const fake = await startFakeServer({ kind: 'stream', text: 'はい' });
    const s = new UiServer({
      config: { ...config(fake, root), initiative: { enabled: false } },
      port: 0,
    });
    await s.start();
    try {
      const session = await s.session();
      // やり残しは無い。思いつきに進まず、そこで止まること。
      assert.equal(await s.idleTick(session), 'HELD');
    } finally { await s.stop(); await fake.close(); }
  });
});
