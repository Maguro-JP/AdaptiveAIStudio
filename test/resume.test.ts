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
import { readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

// 置き場は**試験ごとに分ける**。共有すると、前の試験の控えと会話が
// 残ったまま次が走り、一緒に走らせたときだけ落ちる。
const dir = await tempDir('aas-resume-');
process.env.AAS_STATE_DIR = dir;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { UnfinishedWork } = await import('../src/core/unfinished.ts');
const { Goals } = await import('../src/core/goals.ts');

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
        runtime: { kind: 'ollama' }, // 偽の相手（openai 互換）へ繋ぐ。既定（inproc）だと GGUF を探しに行く
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

  test('**続きのやりとりは、元の会話のファイルへ書く**（いま本体に載っている別の会話へ書かない）', async () => {
    const state = await ownState('conv');
    const root = await tempDir('aas-resume-root-conv-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'では、このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    const post = (p: string, body: unknown) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const idle = async () => {
      for (let i = 0; i < 300; i += 1) {
        const c = await (await fetch(`${base}/api/conversations`)).json() as { running: string | null; runningAll: string[] };
        if (c.running === null && c.runningAll.length === 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail('終わらない');
    };
    try {
      // 会話 A の依頼が止まって、やり残しになる
      const mine = await ask(base, 'A の依頼を直して');
      await idle();
      const a = (await (await fetch(`${base}/api/conversations`)).json() as { current: string }).current;
      // 別の会話 B を開いて、1ターンやりとりする（本体には B が載る）
      fake.setBehavior({ kind: 'stream', text: 'B の答え' });
      await post('/api/conversations', {});
      const b = (await (await post('/api/send', { text: 'B の依頼' })).json() as { conversationId: string }).conversationId;
      await idle();
      assert.notEqual(a, b);

      // 時を進め、続きを始めさせる
      await new UnfinishedWork(join(state, 'unfinished.jsonl')).bump(mine.id, Date.now() - 60 * 60_000);
      fake.setBehavior({ kind: 'stream', text: '続きを直しました' });
      assert.equal(await s.idleTick(await s.session()), 'RESUMED');
      for (let i = 0; i < 300; i += 1) {
        const now = await (await fetch(`${base}/api/unfinished`)).json() as { list: { id: string }[] };
        if (!now.list.some((u) => u.id === mine.id)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await idle();
      const talk = (id: string) => readFile(join(state, 'conversations', `${id}.jsonl`), 'utf8');
      assert.match(await talk(a), /続きを直しました/, '続きのやりとりが、元の会話に無い');
      assert.doesNotMatch(await talk(b), /続きを直しました|前回の続きです/, '続きのやりとりを、別の会話のファイルへ書いた');
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
      const after = await (await fetch(`${base}/api/unfinished`)).json() as { list: { id: string }[]; canceled: { id: string; request: string }[] };
      assert.ok(!after.list.some((u) => u.id === id), 'やめたのに残っている');
      // 立ち上げてからやめたものは、戻す口に並ぶ（画面が読み直しても消えない）
      assert.deepEqual(after.canceled.map((c) => [c.id, c.request]), [[id, 'docs を直して']]);
      // 押し間違えは戻せる（元の依頼の文は、やり残しの記録にしか無い）
      const back = await fetch(`${base}/api/unfinished/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
      assert.equal(back.status, 200);
      const again = await (await fetch(`${base}/api/unfinished`)).json() as { list: { id: string; request: string }[] };
      assert.equal(again.list.find((u) => u.id === id)?.request, 'docs を直して', '戻していない');
      assert.deepEqual((again as unknown as { canceled: unknown[] }).canceled, [], '戻したのに、戻す口に残っている');
      const unknown = await fetch(`${base}/api/unfinished/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'u-none' }),
      });
      assert.equal(unknown.status, 404);
      assert.equal(((await unknown.json()) as { gone?: boolean }).gone, true);
    } finally { await s.stop(); await fake.close(); }
  });

  test('**やめた依頼の段取りも閉じる**（開いたまま残すと、同じ依頼をもう一度頼んだときに古い段取りの続きから始める）', async () => {
    const state = await ownState('b2');
    const root = await tempDir('aas-resume-root2b-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const { id } = await ask(base, 'tests を直して');
      assert.ok(await new UnfinishedWork(join(state, 'unfinished.jsonl')).add({ request: 'docs も直して', why: 'maxTurns', note: '' }));
      const goals = new Goals(join(state, 'goals.jsonl'));
      await goals.open('tests を直して', ['読む', '直す']);
      await goals.open('docs も直して', ['読む']);
      const del = await fetch(`${base}/api/unfinished?id=${id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.deepEqual((await goals.list()).map((g) => g.request), ['docs も直して'],
        'やめた依頼の段取りが開いたまま、または生きている依頼の段取りまで閉じた');
    } finally { await s.stop(); await fake.close(); }
  });

  test('**一段を進めている最中にやめたら、「片づきました」と言わず、やり残しの記録に done も書かない**', async () => {
    const state = await ownState('b3');
    const root = await tempDir('aas-resume-root2c-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const logs: string[] = [];
    let unfinishedEvents = 0;
    const orig = s.broadcast.bind(s);
    (s as { broadcast: unknown }).broadcast = (m: { type: string; level?: string; text?: string }) => {
      if (m.type === 'log') logs.push(`${m.level}: ${m.text}`);
      if (m.type === 'unfinished') unfinishedEvents += 1;
      return orig(m as Parameters<typeof orig>[0]);
    };
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const { id } = await ask(base, 'lib を直して');
      // 一度落ちたことにして、時を過去にする（次の見回りで段に割って進める）。
      await new UnfinishedWork(join(state, 'unfinished.jsonl')).bump(id, Date.now() - 60 * 60_000);
      fake.setBehavior({ kind: 'stream', text: 'ファイルを読んで確かめる\nテストを直して走らせる\n' });
      const session = await s.session();
      const asked = fake.requests;
      assert.equal(await s.idleTick(session), 'RESUMED');
      // 割り終えたら、一段をゆっくりにする（その間にやめる）。
      for (let i = 0; i < 2000 && fake.requests === asked; i += 1) await new Promise((r) => setTimeout(r, 5));
      fake.setBehavior({ kind: 'echo', delayMs: 800 });
      const goals = new Goals(join(state, 'goals.jsonl'));
      for (let i = 0; i < 300 && (await goals.list()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal((await goals.list()).length, 1, '段取りが立っていない');
      const logsAtCancel = logs.length;
      const eventsAtCancel = unfinishedEvents;
      const del = await fetch(`${base}/api/unfinished?id=${id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      // やめた口の知らせ（一回）と、一段の終わりの知らせ（一回以上）を待つ。
      for (let i = 0; i < 400 && unfinishedEvents < eventsAtCancel + 2; i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.ok(unfinishedEvents >= eventsAtCancel + 2, '一段が終わっていない');
      const after = logs.slice(logsAtCancel);
      assert.deepEqual(after.filter((l) => /片づきました|諦めました|割り直しても通りませんでした|しばらく置いて/.test(l)), [],
        `やめた依頼について、片づいた・諦めたと言った: ${after.join(' / ')}`);
      const raw = await readFile(join(state, 'unfinished.jsonl'), 'utf8');
      assert.ok(!raw.includes('"how":"done"'), `やめた依頼に done を書き足した: ${raw}`);
      assert.deepEqual(await goals.list(), [], '段取りが開いたまま');
    } finally { await s.stop(); await fake.close(); }
  });

  test('**一段を進めている最中にやめて戻しても、その一段で依頼全体を片づけない**（戻す口は、その回の間は断る）', async () => {
    const state = await ownState('b4');
    const root = await tempDir('aas-resume-root2d-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'このあと直します。',
    });
    const s = new UiServer({ config: config(fake, root), port: 0 });
    const logs: string[] = [];
    let unfinishedEvents = 0;
    const orig = s.broadcast.bind(s);
    (s as { broadcast: unknown }).broadcast = (m: { type: string; level?: string; text?: string }) => {
      if (m.type === 'log') logs.push(`${m.level}: ${m.text}`);
      if (m.type === 'unfinished') unfinishedEvents += 1;
      return orig(m as Parameters<typeof orig>[0]);
    };
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const { id } = await ask(base, 'app を直して');
      const path = join(state, 'unfinished.jsonl');
      await new UnfinishedWork(path).bump(id, Date.now() - 60 * 60_000);
      fake.setBehavior({ kind: 'stream', text: 'ファイルを読んで確かめる\nテストを直して走らせる\n' });
      const session = await s.session();
      const asked = fake.requests;
      assert.equal(await s.idleTick(session), 'RESUMED');
      for (let i = 0; i < 2000 && fake.requests === asked; i += 1) await new Promise((r) => setTimeout(r, 5));
      // 一段は「済んだ」で返す（ここで落ちると、依頼全体を片づけるかが見える）
      fake.setBehavior({ kind: 'echo', delayMs: 800 });
      const goals = new Goals(join(state, 'goals.jsonl'));
      for (let i = 0; i < 300 && (await goals.list()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal((await goals.list()).length, 1, '段取りが立っていない');
      const logsAtCancel = logs.length;
      const eventsAtCancel = unfinishedEvents;
      const attemptsBefore = (await new UnfinishedWork(path).list()).find((u) => u.id === id)!.attempts;
      assert.equal((await fetch(`${base}/api/unfinished?id=${id}`, { method: 'DELETE' })).status, 200);
      const refused = await fetch(`${base}/api/unfinished/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
      assert.equal(refused.status, 409, '走っている回の最中に戻した');
      assert.notEqual(((await refused.json()) as { gone?: boolean }).gone, true, '回が終われば戻せるのに、戻す口を下げさせる');
      // 口を通らずに戻った場合（別のタブ・手で）も、一段の終わりで依頼全体を「片づいた」にしない
      assert.equal(await new UnfinishedWork(path).reopen(id), 'reopened');
      for (let i = 0; i < 400 && unfinishedEvents < eventsAtCancel + 2; i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.ok(unfinishedEvents >= eventsAtCancel + 2, '一段が終わっていない');
      const after = logs.slice(logsAtCancel);
      assert.deepEqual(after.filter((l) => /片づきました/.test(l)), [], `一段で依頼全体を片づけた: ${after.join(' / ')}`);
      const raw = await readFile(path, 'utf8');
      assert.ok(!raw.includes('"how":"done"'), `戻した依頼に done を書いた: ${raw}`);
      const back = (await new UnfinishedWork(path).list()).find((u) => u.id === id);
      assert.ok(back, '戻した依頼が残っていない');
      // 段取りの外で閉じられた一段の結果は、やり残しに書かない（済めば片づけ、落ちればやり直しの回数を足していた）
      assert.equal(back.attempts, attemptsBefore, `閉じた段取りの一段の結果を、やり残しに書いた: ${raw}`);
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
      // **決め打ちで待たない。**待ちが短いと「まだ控えられていないだけ」を
      // 「控えていない」と読んでしまい、壊れていても通る。
      // 答えが会話に載るまで待ってから、控えの数を見る。
      const until = Date.now() + 30_000;
      for (;;) {
        const list = await (await fetch(`${base}/api/conversations`)).json() as { list?: { id: string }[] };
        const id = list.list?.[0]?.id;
        if (id) {
          const msgs = await (await fetch(`${base}/api/conversations/messages?id=${id}`)).json() as { messages?: { role?: string }[] };
          if ((msgs.messages ?? []).some((m) => m.role === 'assistant')) break;
        }
        if (Date.now() >= until) assert.fail('答えが返ってこない');
        await new Promise((r) => setTimeout(r, 50));
      }
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

/**
 * やり残しは、走った作業場で続ける。
 *
 * やり残しの記録は一つで、作業場ごとに分かれていなかった。作業場を変えたあとの見回りは、前の作業場の依頼を
 * 新しい作業場で続けていた（別のプロジェクトのファイルを、その依頼のつもりで書き換える）。
 */
describe('やり残しは、走った作業場で続ける', () => {
  test('記録に走った作業場が残り、別の作業場を開いているときは続けない', async () => {
    const state = await ownState('root');
    const root = await tempDir('aas-resume-rootA-');
    const other = await tempDir('aas-resume-rootB-');
    const fake = await startFakeServer({
      kind: 'stalls', name: 'list_files', args: { path: '.' },
      then: 'では、このあと直します。',
    });
    const s = new UiServer({ config: { ...config(fake, root), initiative: { enabled: false } }, port: 0 });
    const base = (await s.start()).replace(/\/$/, '');
    try {
      const mine = await ask(base, 'README を直して');
      const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
      const kept = (await store.list()).find((u) => u.id === mine.id)!;
      assert.equal(kept.root, root, '走った作業場を記録していない');

      // 別の作業場の分だけにする（今のものは片づけ、別の作業場の記録を時が来た形で置く）
      await store.cancel(mine.id);
      const elsewhere = await store.add({ request: '別のプロジェクトの依頼', why: 'maxTurns', note: 'x', root: other });
      assert.ok(elsewhere);
      await store.bump(elsewhere.id, Date.now() - 60 * 60_000);
      fake.setBehavior({ kind: 'stream', text: '直しました。' });
      const session = await s.session();
      assert.equal(await s.idleTick(session), 'HELD', '別の作業場の依頼を、この作業場で続けた');
    } finally { await s.stop(); await fake.close(); }
  });
});
