/**
 * 作業場（コードを書き換える先）の既定。
 *
 * ここまで、決めずに「いま居る場所」（cwd）を使っていた。
 * 作業コピーから動かすぶんには正しい。**入れた版では致命的になる。**
 *
 * 入れる版の入口は `app\start.cmd` で、そこは `cd /d "%~dp0"` する。
 * つまり作業場が `%ProgramFiles%\AdaptiveAIStudio\app` になる。
 * そこは管理者権限が無いと書けない。**入れて、最初に何か書かせた瞬間に弾かれる。**
 * 書けたら書けたで、プログラムのフォルダを汚す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { defaultWorkRoot, isDistributed } from '../src/core/home.ts';

/** 入れた版の形を作る。app\ が中身で、その隣に data\。 */
async function installed(portable = false): Promise<{ product: string; app: string }> {
  const product = await tempDir('aas-work-');
  const app = join(product, 'app');
  await mkdir(app, { recursive: true });
  // 配った形は app\ の隣に入口がある（名前が app なだけのクローンと見分ける）
  await writeFile(join(product, 'AdaptiveAIStudio.cmd'), '@echo off\r\n');
  if (portable) await writeFile(join(product, '.portable'), '');
  return { product, app };
}

describe('作業場の既定', () => {
  test('プログラムの中に居るなら、そこは使わない', async () => {
    const { app } = await installed();
    const home = await tempDir('aas-home-');
    const prev = process.env.AAS_HOME;
    process.env.AAS_HOME = home;
    try {
      // いま居るのが app\ の中。**ここに書かせない。**
      assert.equal(defaultWorkRoot(app, app), join(home, 'work'));
      // app\ の下の、さらに深いところでも同じ。
      assert.equal(defaultWorkRoot(join(app, 'src', 'core'), app), join(home, 'work'));
    } finally { if (prev === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prev; }
  });

  test('持ち運び版でも、プログラムの隣は使わない', async () => {
    const { product, app } = await installed(true);
    const prev = process.env.AAS_HOME;
    delete process.env.AAS_HOME;
    try {
      // 持ち運び版の根は product\data。作業場はその下の work。
      assert.equal(defaultWorkRoot(product, app), join(product, 'data', 'work'));
      assert.equal(defaultWorkRoot(app, app), join(product, 'data', 'work'));
    } finally { if (prev !== undefined) process.env.AAS_HOME = prev; }
  });

  test('外に居るなら、そこをそのまま使う（対）', async () => {
    // 利用者が開いた自分の作業場。**取り上げない。**
    const { app } = await installed();
    const mine = await tempDir('aas-mine-');
    assert.equal(defaultWorkRoot(mine, app), mine);
  });

  test('作業コピーは取り上げない（対）', async () => {
    // **ここで一度壊した。**作業コピーまでプログラム扱いにしたので、
    // この道具で自分自身を直す使い方が働かなくなった（巡回で捕まえた）。
    // bundle は中身を必ず app\ に入れる。作業コピーにその形は無い。
    const repo = await tempDir('aas-repo-');
    await mkdir(join(repo, 'src'), { recursive: true });
    assert.equal(isDistributed(repo), false, '作業コピーをbundle と見ている');
    assert.equal(defaultWorkRoot(repo, repo), repo);
  });

  test('配られた形は、置かれ方で見分ける', async () => {
    const { product, app } = await installed();
    assert.equal(isDistributed(app), true, 'app\ に入っているのに見分けていない');
    assert.equal(isDistributed(product), false);
    const { app: papp } = await installed(true);
    assert.equal(isDistributed(papp), true, '持ち運び版を見分けていない');
  });

  test('**名前が app なだけのクローン（Docker の /app など）は、配った形と見なさない**', async () => {
    const base = await tempDir('aas-docker-');
    const app = join(base, 'app');
    await mkdir(join(app, 'src'), { recursive: true });
    assert.equal(isDistributed(app), false, '名前だけで配った形と見た');
    assert.equal(defaultWorkRoot(app, app), app, 'クローンの作業場をよそへ移した');
  });

  test('VERSION だけが隣にある形も、配った形と見る（対）', async () => {
    const base = await tempDir('aas-version-only-');
    const app = join(base, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(base, 'VERSION'), '0.12.1\n');
    assert.equal(isDistributed(app), true);
  });

  test('無ければ作る。作らないと、開いた瞬間に落ちる', async () => {
    // 初回は work\ が無い。無いまま一覧を読むと「そんな場所は無い」で落ちる。
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const { Session } = await import('../src/core/session.ts');
    const { startFakeServer } = await import('./fake-server.ts');
    const fake = await startFakeServer({ kind: 'stream', text: 'はい' });
    const home = await tempDir('aas-mk-');
    const root = join(home, 'work');
    try {
      const session = await Session.create({
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        agent: { root, approval: 'auto' },
      } as never, { approve: () => Promise.resolve(true) });
      try {
        assert.ok((await stat(root)).isDirectory(), '作業場が作られていない');
      } finally { await session.close(); }
    } finally { await fake.close(); }
  });
});
