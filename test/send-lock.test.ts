/**
 * 送り口（send）は、書き得る手を初めて使う時点で作業場の錠を取り、依頼の終わりに返す。
 *
 * 二つの会話が同じ作業場へ同時に書くと、互いの書き込みを外の変化と読み違え、巻き戻しで相手の仕事まで
 * 戻し、「戻す」の記録も混ざる（DECISIONS 09-26）。錠を別の持ち主が持っている間は書かずに待つこと、
 * 読むだけの回は錠を取らないこと、終われば返すことを見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-send-lock-state-');
const { Session } = await import('../src/core/session.ts');

let fake: FakeServer;
before(async () => { fake = await startFakeServer({ kind: 'stream', text: 'はい。' }); });
after(async () => { await fake.close(); });

async function open() {
  const root = join(await tempDir('aas-send-lock-'), 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'note.txt'), 'もと\n');
  const session = await Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 3 },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  return { root, session };
}

describe('送り口と作業場の錠', { timeout: 60_000 }, () => {
  test('ほかが錠を持っている間は書かずに待ち、返されたら書いて、終われば返す', async () => {
    const { root, session } = await open();
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [
          { name: 'read_file', args: { path: 'note.txt' } },
          { name: 'write_file', args: { path: 'note.txt', content: '書いた\n' } },
        ],
        then: '書きました。',
      });
      await session.lock.acquire('other');
      let heldDuring: string | undefined;
      const run = (async () => {
        for await (const ev of session.send('note.txt を書き換えて')) {
          if (ev.type === 'toolEnd' && ev.name === 'write_file') heldDuring = session.lock.owner;
        }
      })();
      // 相手が持っている間は書かない。
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'もと\n', '錠を待たずに書いた');
      assert.equal(session.lock.waiting, 1, '錠を待っていない');
      session.lock.release('other');
      await run;
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '書いた\n');
      assert.match(heldDuring ?? '', /^send:/, '書いている間に錠を持っていない');
      assert.equal(session.lock.held, false, '終わっても錠を返していない');
      // 錠を取ってから始めた戻り先に、書いた分が載る。
      const [point] = await session.undo.list();
      assert.ok(point?.paths.includes('note.txt'), '「戻す」に載っていない');
    } finally {
      await session.close();
    }
  });

  test('読むだけの回は錠を取らない（ほかが持っていても待たずに終わる）', async () => {
    const { session } = await open();
    try {
      fake.setBehavior({
        kind: 'steps',
        calls: [{ name: 'read_file', args: { path: 'note.txt' } }],
        then: 'もと、と書いてあります。',
      });
      await session.lock.acquire('other');
      const seen: string[] = [];
      for await (const ev of session.send('note.txt に何が書いてある？')) seen.push(ev.type);
      assert.ok(seen.includes('settled'), `終わっていない: ${seen.join(',')}`);
      assert.equal(session.lock.owner, 'other', '読むだけなのに錠に触った');
      session.lock.release('other');
    } finally {
      await session.close();
    }
  });
});
