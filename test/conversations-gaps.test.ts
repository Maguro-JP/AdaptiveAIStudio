/**
 * 79 回目の不具合調査（会話の一覧と読み書き）の分。
 *
 * - 読めない会話を「古いので出していない」に混ぜない（数を別に返す）
 * - 見出しの付け替えで、古い会話を一覧の先頭に上げない
 * - 会話の中身を返す口は、消した会話に 404、読めない会話に道の入らない 503 を返す
 *
 * 会話の保存先のフォルダそのものが読めない（権限）ときの扱いは、root で走るここでは作れないので確かめていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, utimes } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-conversations-gaps-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { Conversations } = await import('../src/core/conversations.ts');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('会話の一覧', () => {
  test('**読めない会話は、読めなかった数として返す（「古いので出していない」に混ぜない）**', async () => {
    const box = await tempDir('aas-conv-list-');
    const c = new Conversations(box);
    await c.create();
    // 会話の名前の形をしたフォルダ（在るが読めない）
    await mkdir(join(box, 'c20260101-000000-0000.jsonl'));
    const list = await c.list();
    assert.equal(list.length, 1);
    assert.equal(await c.count(), 2);
    assert.equal(c.lastUnreadable, 1, '読めなかった会話を数えていない');
  });

  test('**見出しを付け替えても、一覧の並び（使った順）を変えない**', async () => {
    const box = await tempDir('aas-conv-rename-');
    const c = new Conversations(box);
    const a = (await c.create()).id;
    const b = (await c.create()).id;
    // a は 3 日前、b は 1 日前に使った（同じミリ秒に並ぶと名前で並び、偶然通った）
    const old = new Date(Date.now() - 3 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    await utimes(join(box, `${a}.jsonl`), old, old);
    await utimes(join(box, `${b}.jsonl`), recent, recent);
    await c.rename(a, '名前を直した');
    const list = await c.list();
    assert.equal(list[0]!.id, b, `名前を変えただけの古い会話が先頭に上がった: ${list.map((h) => h.id).join(', ')}`);
  });
});

describe('会話の中身を返す口', () => {
  test('**消した会話には 404、読めない会話には道の入らない 503**', async () => {
    const fake = await startFakeServer({ kind: 'echo' });
    const server = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        runtime: { kind: 'ollama' },
        agent: { root: dir, approval: 'auto' },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const gone = await fetch(`${base}/api/conversations/messages?id=c20250101-000000-0001`);
      assert.equal(gone.status, 404, '無い会話を空の会話として返した');
      const convDir = join(dir, 'state', 'conversations');
      await mkdir(join(convDir, 'c20250101-000000-0002.jsonl'), { recursive: true });
      const broken = await fetch(`${base}/api/conversations/messages?id=c20250101-000000-0002`);
      assert.equal(broken.status, 503);
      const body = await broken.json() as { error: string };
      assert.doesNotMatch(body.error, new RegExp(convDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), `道をそのまま返した: ${body.error}`);
    } finally {
      await server.stop();
      await fake.close();
    }
  });
});
