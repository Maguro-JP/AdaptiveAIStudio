/**
 * 作業前検査を、書き換えが起きるまで流さない。
 *
 * ここまで、依頼のたびに**いちばん先に検査を丸ごと流していた**。
 * 「この関数は何をしていますか」と訊いただけで数分止まり、
 * 画面からは固まったようにしか見えなかった（利用者から言われた）。
 *
 * 訊いただけなら流さない。ファイルを触る直前に流す。
 * どちらも、実際に流れた回数で見る（言葉ではなく、走った跡で確かめる）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_CONFIG, type AasConfig } from '../src/config.ts';

let fake: FakeServer;
let root = '';
/** 検査が流れるたびに1行増えるファイル。**流れた回数を、跡で数える。** */
let marker = '';

async function ranCount(): Promise<number> {
  const raw = await readFile(marker, 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.length > 0).length;
}

before(async () => {
  root = await tempDir('aas-lazy-');
  marker = join(root, 'ran.txt');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'もとの中身\n');
  // 検査の中身は「走った印を足す」だけ。速く、回数が数えられる。
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0',
    scripts: { test: `node -e "require('fs').appendFileSync('ran.txt','x\\n')"` },
  }));
  fake = await startFakeServer({ kind: 'stream', text: '読みました。' });
});
after(async () => { await fake.close(); });

function config(): AasConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    agent: { root, approval: 'auto' },
  } as AasConfig;
}

/** 一往復ぶん流し切る。 */
async function ask(session: Session, text: string): Promise<string[]> {
  const seen: string[] = [];
  for await (const ev of session.send(text)) seen.push(ev.type);
  return seen;
}

describe('作業前検査は、触る直前まで流さない', () => {
  test('訊いただけなら、検査は流れない', async () => {
    fake.setBehavior({ kind: 'stream', text: 'これは説明です。' });
    const session = await Session.create(config(), { approve: () => Promise.resolve(true) });
    try {
      const before = await ranCount();
      const seen = await ask(session, 'src/a.txt は何ですか');
      assert.equal(await ranCount(), before, '訊いただけで検査が流れている');
      assert.ok(!seen.includes('baseline'), `作業前検査を出している: ${seen.join(',')}`);
    } finally { await session.close(); }
  });

  test('書き換えるなら、触る直前に流れる（対）', async () => {
    // 「流さない」だけなら、常に流さない作りでも通ってしまう。対で見る。
    fake.setBehavior({
      kind: 'toolcall',
      name: 'write_file',
      args: { path: 'src/a.txt', content: '書き換えました\n' },
      then: '書き換えました。',
    });
    const session = await Session.create(config(), { approve: () => Promise.resolve(true) });
    try {
      const before = await ranCount();
      const seen = await ask(session, 'src/a.txt を書き換えて');
      assert.ok(await ranCount() > before, '書き換えたのに検査が流れていない');
      assert.ok(seen.includes('baseline'), `作業前検査が出ていない: ${seen.join(',')}`);
      // 触る前に控えていること。控えが無いと、作業後の検査そのものが回らない。
      assert.ok(seen.includes('verify'), `作業後の検査が回っていない: ${seen.join(',')}`);
    } finally { await session.close(); }
  });
});
