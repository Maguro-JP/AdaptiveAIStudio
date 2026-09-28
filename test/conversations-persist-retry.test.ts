/**
 * 会話を書き足せなかったターンを、次のターンで書き直す。
 *
 * 前は書けなくても「ここまで残した」を進めていたので、一瞬書けなかった（Windows の EBUSY など）ターンは、次の保存でも書かれずに
 * ファイルから抜け落ちた。画面には出ているので、立ち上げ直すまで気づけない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-conv-persist-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { Conversations } = await import('../src/core/conversations.ts');

test('**書けなかったターンは、次のターンで書き直す**（ファイルから抜け落ちない）', async () => {
  const fake = await startFakeServer({ kind: 'echo' });
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'ollama' },
    agent: { root: dir, approval: 'auto' },
    initiative: { enabled: false },
  } as typeof DEFAULT_CONFIG;
  const server = new UiServer({ port: 0, config });
  const base = (await server.start()).replace(/\/$/, '');
  const send = async (text: string): Promise<string> => {
    const r = await (await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    })).json() as { conversationId: string };
    await until(async () => {
      const c = await (await fetch(`${base}/api/conversations`)).json() as { running: string | null; runningAll: string[] };
      return c.running === null && c.runningAll.length === 0;
    }, `「${text}」が終わる`, { timeoutMs: 15000, everyMs: 50 });
    return r.conversationId;
  };
  try {
    const id = await send('一つ目の依頼');
    const file = join(dir, 'state', 'conversations', `${id}.jsonl`);
    assert.match(await readFile(file, 'utf8'), /一つ目の依頼/);

    // 会話のファイルの場所にフォルダを置いて、書き足せなくする（root で走っても同じ結果になる）
    await rename(file, `${file}.away`);
    await mkdir(file);
    await send('二つ目の依頼');
    await rmdir(file);
    await rename(`${file}.away`, file);
    assert.doesNotMatch(await readFile(file, 'utf8'), /二つ目の依頼/, '書けないはずの間に書けた（この試験の前提が崩れた）');

    await send('三つ目の依頼');
    // 利用者の発言の並びで見る（答えは依頼の文を写し返すので、文字の数では数えない）
    const asked = (await new Conversations(join(dir, 'state', 'conversations')).load(id))
      .filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(asked, ['一つ目の依頼', '二つ目の依頼', '三つ目の依頼'], '書けなかったターンが抜け落ちたか、書けた分まで二重に書いた');
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('会話の書き足しは、一時的な失敗（EBUSY・EPERM）をやり直す。ほかの失敗はそのまま投げる', async () => {
  const d = await tempDir('aas-conv-append-retry-');
  let fails = 2;
  const c = new Conversations(d, {
    append: async (p, t) => {
      if (fails-- > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      const { appendFile } = await import('node:fs/promises');
      await appendFile(p, t, 'utf8');
    },
  });
  const { id } = await c.create();
  await c.append(id, [{ role: 'user', content: 'やり直して書けた' }]);
  assert.deepEqual((await c.load(id)).map((m) => m.content), ['やり直して書けた']);

  const full = new Conversations(d, { append: async () => { throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' }); } });
  await assert.rejects(full.append(id, [{ role: 'user', content: 'x' }]), /ENOSPC/);
});
