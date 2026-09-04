/**
 * 実走。**本物の作業場で、依頼から直るところまでを通す。**
 *
 * ここまでの試験は、部品ごとに正しいことしか見ていなかった。
 * 部品が全部正しくても、繋いだ全体が動かないことは起きる（実際に起きた）。
 *
 * ここでは
 *   - 本物のファイル（壊れた足し算と、それを見る試験）を temp に置き
 *   - 本物の画面サーバを立て、本物の道具・承認・検問所を通し
 *   - 道具の結果を読んでから次を決める相手（`real-run.ts`）を繋ぎ
 *   - **直ったこと**を、ファイルの中身と、その作業場の試験で確かめる
 *
 * 賢さは相手（モデル）の仕事なので、そこは持たせない。持たせるのは段取りだけ。
 * それでも、繋ぎ目が壊れていればここで落ちる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tempDir } from './tmp.ts';
import { startRealModel } from './real-run.ts';

process.env.AAS_STATE_DIR ??= await tempDir('aas-real-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const run = promisify(execFile);

/** 壊れた作業場を作る。足し算のはずが引き算になっている。 */
async function brokenProject(): Promise<string> {
  const root = await tempDir('aas-work-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'math.js'), [
    '// 二つの数を足す。請求書の合計を出すのに使う。',
    'export function add(a, b) {',
    '  return a - b;',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(root, 'test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './src/math.js';",
    "test('足し算', () => { assert.equal(add(2, 3), 5); });",
    '',
  ].join('\n'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'broken', type: 'module', scripts: { test: 'node --test test.js' },
  }, null, 2));
  return root;
}

/**
 * その作業場の試験を、そのまま走らせる。
 *
 * **`NODE_TEST_CONTEXT` を切る。**これが子へ漏れると、node は
 * 「親の試験係へ報告する子」として振る舞い、落ちても 0 で返る。
 * 実際にそれで、壊れている作業場が「通った」ことになった。
 * 土台が嘘をつくと、この試験そのものが意味を失う。
 */
async function projectTestPasses(root: string): Promise<boolean> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    await run(process.execPath, ['--test', 'test.js'], { cwd: root, timeout: 60_000, env });
    return true;
  } catch { return false; }
}

/** 出来事を、静かになるまで溜める。 */
async function drive(base: string, text: string, ms = 90_000): Promise<unknown[]> {
  const events: unknown[] = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';

  // **前の会話を引きずらない。**記録は残る作りなので、
  // 立ち上げ直しても前のやりとり（道具の結果を含む）が載ってくる。
  // 製品としてはそれでよいが、ここでは一件ずつ独立に見たい。
  await fetch(`${base}/api/conversations`, { method: 'POST' });

  const sent = await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  assert.equal(sent.status, 202, await sent.text());

  const deadline = Date.now() + ms;
  let done = false;
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
  while (Date.now() < deadline && !done) {
    pending ??= reader.read();
    const got = await Promise.race([
      pending.then((r) => ({ value: r.value, fromRead: true as const })),
      new Promise<{ value: undefined; fromRead: false }>((r) => setTimeout(() => r({ value: undefined, fromRead: false }), 400)),
    ]);
    if (got.fromRead) pending = undefined;
    if (got.value) buf += dec.decode(got.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const part = buf.slice(0, nl); buf = buf.slice(nl + 2);
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try { events.push(JSON.parse(line.slice(6))); } catch { /* 注釈 */ }
      }
    }
    done = events.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy'
      && (e as { busy?: boolean }).busy === false);
  }
  ac.abort();
  return events;
}

describe('実走：壊れているものが、直って、その作業場の試験が通る', () => {
  test('依頼から、直るところまで', async () => {
    const root = await brokenProject();
    // まず、本当に壊れていることを確かめる。壊れていないものを直しても意味がない。
    assert.equal(await projectTestPasses(root), false, '壊れていない作業場で試している');

    const model = await startRealModel({ hint: '足し算', from: 'a - b', to: 'a + b' });
    const server = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: model.baseUrl, locality: 'local', models: ['real'] }],
        candidates: ['local:real'],
        runtime: { kind: 'ollama' },
        agent: { root, approval: 'auto', verify: { enabled: false } },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await server.start()).replace(/\/$/, '');

    try {
      const events = await drive(base, '足し算が引き算になっています。直してください。');

      // 段取りが、思った通りに進んだか。
      // **読む回数は決めない。**探し物の言葉は試験の側にも書いてあるので、
      // 上位に試験が来ることがある（実際に来た）。一発で当たる前提にしない。
      const how = model.did.join(' → ');
      assert.equal(model.did[0], 'find_code', `探すところから始めていない: ${how}`);
      assert.equal(model.did[model.did.length - 1], 'edit_file', `直して終わっていない: ${how}`);
      assert.equal(model.did.filter((n) => n === 'edit_file').length, 1, `二度直している: ${how}`);
      assert.ok(model.did.includes('read_file'), `読まずに直している: ${how}`);

      // **中身が直っているか。**ここが本題。
      const now = await readFile(join(root, 'src', 'math.js'), 'utf8');
      assert.match(now, /return a \+ b;/, `直っていない:\n${now}`);

      // **その作業場の試験が、実際に通るか。**
      assert.equal(await projectTestPasses(root), true, '直したのに、その作業場の試験が通らない');

      // 途中で落ちていないか（落ちても最後まで進むことがある）。
      const errors = events
        .filter((e) => (e as { type?: string; level?: string }).type === 'log'
          && (e as { level?: string }).level === 'error')
        .map((e) => (e as { text?: string }).text);
      assert.deepEqual(errors, [], `途中で落ちている: ${errors.join(' / ')}`);
    } finally {
      await server.stop();
      await model.close();
    }
  });
});

describe('実走：直したあと、こちらで試験を回して「直った」と言えるか', () => {
  test('壊れているうちは通らず、直したら通る、を自分で見る', async () => {
    const root = await brokenProject();
    const model = await startRealModel({ hint: '足し算', from: 'a - b', to: 'a + b' });
    const server = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: model.baseUrl, locality: 'local', models: ['real'] }],
        candidates: ['local:real'],
        runtime: { kind: 'ollama' },
        agent: {
          root, approval: 'auto',
          // 作業場そのものの試験を、製品の側から回す。
          verify: { enabled: true, command: `${process.execPath} --test test.js`, maxRounds: 1 },
        },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await server.start()).replace(/\/$/, '');

    try {
      const events = await drive(base, '足し算が引き算になっています。直してください。', 120_000);
      const inner = events
        .filter((e) => (e as { type?: string }).type === 'session')
        .map((e) => (e as { event: Record<string, unknown> }).event);

      // 回したことを言っているか。黙って飛ばしていないか。
      const rounds = inner
        .filter((ev) => ev.type === 'verify')
        .map((ev) => (ev.event as { type?: string })?.type);
      assert.ok(rounds.includes('running'), `試験を回していない: ${JSON.stringify(inner.map((e) => e.type))}`);
      assert.ok(rounds.includes('passed'), `通ったと言っていない: ${rounds.join(', ')}`);

      // **通ったと言っているか。**ここが本題。
      const settled = inner.find((ev) => ev.type === 'settled') as
        { verified?: boolean; detail?: string } | undefined;
      assert.ok(settled, '終わりを記録していない');
      assert.equal(settled.verified, true, `通っていないのに通ったと言っている / 逆: ${JSON.stringify(settled)}`);

      // 言っているだけでないことを、外から確かめる。
      assert.equal(await projectTestPasses(root), true, '製品は通ったと言うが、実際は通らない');
    } finally {
      await server.stop();
      await model.close();
    }
  });

  test('直せなかったときは、通ったと言わない（対）', async () => {
    // **ここが逆に壊れているのが、いちばん危ない。**
    // 落ちたものを「完了・検証済み」と記録していたことが、実際にあった。
    const root = await brokenProject();
    // 当たらない直し方をさせる。直らないまま終わる。
    const model = await startRealModel({ hint: '足し算', from: 'ここには無い文字列', to: 'x' });
    const server = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: model.baseUrl, locality: 'local', models: ['real'] }],
        candidates: ['local:real'],
        runtime: { kind: 'ollama' },
        agent: {
          root, approval: 'auto',
          verify: { enabled: true, command: `${process.execPath} --test test.js`, maxRounds: 1 },
        },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await server.start()).replace(/\/$/, '');

    try {
      const events = await drive(base, '足し算が引き算になっています。直してください。', 120_000);
      assert.equal(await projectTestPasses(root), false, '直っていないはずが、直っている');

      // **直っていないのに「検証済み」と言わないこと。**
      // 落ちたものを完了として記録していたことが、実際にあった。
      const inner = events
        .filter((e) => (e as { type?: string }).type === 'session')
        .map((e) => (e as { event: Record<string, unknown> }).event);
      const settled = inner.find((ev) => ev.type === 'settled') as
        { verified?: boolean; checked?: string } | undefined;
      assert.notEqual(settled?.verified, true, '通っていないのに、通ったと言っている');
      assert.notEqual(settled?.checked, 'passed', '確かめていないのに、通ったと言っている');
      const now = await readFile(join(root, 'src', 'math.js'), 'utf8');
      assert.match(now, /return a - b;/, `触ってはいけないものを触っている:\n${now}`);
    } finally {
      await server.stop();
      await model.close();
    }
  });
});
