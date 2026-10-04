/**
 * 記憶と会話の保存の不具合（22 回目の調査）。
 *
 * - 呼び戻しの問いは打った分だけ（差し込んだ添付の中身で、どの覚えにも当たっていた）
 * - 欄の形の違う行（detail が無い・tags が数・seenAt が文字）で、思い出すたびに落ちない
 * - 別の作業場に同じ題が在っても、忘れた覚えを戻せる
 * - 英字に仮名が続く語・全角英数で、呼び戻しが外れない
 * - 会話の書き足しが途中で失敗しても、書き直しで行が二重にならない
 * - トップのまま本体が組まれても、空の会話を作らない
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-memory-gaps-state-');
process.env.AAS_CONFIG = join(await tempDir('aas-memory-gaps-config-'), 'aas.config.json');
const { Memory, tokenize, normalizeTitle } = await import('../src/memory/memory.ts');

async function memoryWith(lines: string[]): Promise<InstanceType<typeof Memory>> {
  const dir = await tempDir('aas-memory-gaps-');
  const path = join(dir, 'memory.jsonl');
  await writeFile(path, lines.join('\n') + '\n');
  const m = new Memory(path);
  await m.load();
  return m;
}

describe('欄の形の違う行', () => {
  test('**detail の無い行を読んでも、思い出すときに落ちない**', async () => {
    const m = await memoryWith([JSON.stringify({ id: 'm1', kind: 'preference', title: 'テストの書き方', tags: [] })]);
    assert.doesNotThrow(() => m.recall('テストの書き方'));
    assert.equal(m.recall('テストの書き方').length, 1);
  });

  test('**tags に数・seenAt に文字が入った行は、思い出す側へ渡さない**（退けた行として残す）', async () => {
    const m = await memoryWith([
      JSON.stringify({ id: 'm1', kind: 'decision', title: 'テストの書き方', detail: 'x', tags: [1], at: 1, seenAt: 1, confirms: 1 }),
      JSON.stringify({ id: 'm2', kind: 'decision', title: 'テストの名前', detail: 'x', tags: [], at: 1, seenAt: 'x', confirms: 1 }),
      JSON.stringify({ id: 'm3', kind: 'decision', title: 'テストの並び', detail: 'x', tags: ['a'], at: 1, seenAt: 1, confirms: 1 }),
    ]);
    assert.doesNotThrow(() => m.recall('テスト'));
    assert.deepEqual(m.recall('テスト').map((e) => e.id), ['m3']);
  });
});

describe('別の作業場の同じ題', () => {
  test('**別の作業場に同じ題が在っても、忘れた覚えを戻せる**', async () => {
    const m = await memoryWith([]);
    const a = m.remember({ kind: 'attempt', title: 'テストを直して', detail: 'a', root: '/a' });
    m.remember({ kind: 'attempt', title: 'テストを直して', detail: 'b', root: '/b' });
    const gone = m.remove(a.entry.id);
    assert.ok(gone);
    assert.equal(m.restore(gone!), true);
  });

  test('同じ作業場に同じ題が在れば、今までどおり二つにしない（対）', async () => {
    const m = await memoryWith([]);
    const a = m.remember({ kind: 'attempt', title: 'テストを直して', detail: 'a', root: '/a' });
    const gone = m.remove(a.entry.id);
    m.remember({ kind: 'attempt', title: 'テストを直して', detail: 'again', root: '/a' });
    assert.equal(m.restore(gone!), 'duplicate');
  });
});

describe('英字と仮名・全角', () => {
  test('**英字に仮名が続く語から、英字の語を取る**', () => {
    assert.ok(tokenize('READMEを直して').includes('readme'));
    assert.ok(tokenize('npmで入れる').includes('npm'));
    assert.deepEqual(tokenize('ＲＥＡＤＭＥ'), ['readme']);
  });

  test('**「READMEを直して」で「README の書き方を決めた」を思い出す**', async () => {
    const m = await memoryWith([]);
    m.remember({ kind: 'decision', title: 'README の書き方を決めた', detail: '見出しは日本語' });
    assert.equal(m.recall('READMEを直して').length, 1);
  });

  test('**全角と半角の英数は、同じ題として畳む**', () => {
    assert.equal(normalizeTitle('ＡＰＩキーを直す'), normalizeTitle('APIキーを直す'));
  });
});

describe('会話の書き足し', () => {
  test('**途中まで書けて失敗しても、書き直しで行が二重にならない**', async () => {
    const { Conversations } = await import('../src/core/conversations.ts');
    const dir = await tempDir('aas-memory-gaps-conv-');
    let failOnce = true;
    const store = new Conversations(dir, {
      append: async (path, text) => {
        if (failOnce) {
          failOnce = false;
          // 半分だけ本当に書いてから、ディスクが一杯になる
          await appendFile(path, text.slice(0, Math.floor(text.length / 2)));
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        }
        await appendFile(path, text);
      },
    });
    const { id } = await store.create();
    const msgs = [
      { role: 'user' as const, content: '直して' },
      { role: 'assistant' as const, content: '直しました' },
    ];
    await assert.rejects(store.append(id, msgs));
    await store.append(id, msgs); // 呼ぶ側は、書けなかった分を丸ごと書き直す
    const back = await store.load(id);
    assert.deepEqual(back.map((m) => m.content), ['直して', '直しました']);
  });
});

describe('呼び戻しの問いと空の会話', () => {
  const servers: { close: () => Promise<void> }[] = [];
  after(async () => { for (const s of servers) await s.close(); });

  test('**添付の中身にだけ現れる語では、覚えを呼び戻さない**（打った分の語なら呼び戻す）', async () => {
    const { startFakeServer } = await import('./fake-server.ts');
    const { Session } = await import('../src/core/session.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const fake = await startFakeServer({ kind: 'stream', text: '答えます。' });
    servers.push(fake);
    const root = await tempDir('aas-memory-gaps-root-');
    const session = await Session.create({
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      agent: { root, approval: 'auto' },
    } as typeof DEFAULT_CONFIG, { approve: () => Promise.resolve(true) });
    try {
      session.memory.remember({ kind: 'decision', title: 'ガラパゴス諸島の旅程を決めた', detail: '三日目は休み' });
      session.memory.remember({ kind: 'decision', title: '関数の名前を決めた', detail: '動詞から始める' });
      const full = `--- 添付: memo.txt ---\nガラパゴス諸島の旅程について\n--- ここまで ---\n\n関数の名前を直して`;
      const recalled: string[] = [];
      for await (const ev of session.send(full, { said: '関数の名前を直して' })) {
        if (ev.type === 'recalled') recalled.push(ev.text);
      }
      const text = recalled.join('\n');
      assert.ok(!text.includes('ガラパゴス'), `添付の語で呼び戻した: ${text}`);
      assert.ok(text.includes('関数の名前'), `打った分の語で呼び戻していない: ${text}`);
    } finally { await session.close(); }
  });

  test('**トップのまま本体が組まれても、空の会話を作らない**', async () => {
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const { stateDir } = await import('../src/core/home.ts');
    const root = await tempDir('aas-memory-gaps-ui-');
    await mkdir(root, { recursive: true });
    const server = new UiServer({ config: { ...DEFAULT_CONFIG, agent: { root } } as typeof DEFAULT_CONFIG, port: 0 });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const dir = join(stateDir(), 'conversations');
      const before = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl')).length;
      // 「戻す」を押すと、本体が組まれる（戻し先が無いので戻しはしない）
      const r = await fetch(`${base}/api/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'u-none' }) });
      assert.equal(r.status, 404, await r.text());
      const after = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl')).length;
      assert.equal(after, before, '空の会話が増えた');
    } finally { await server.stop(); }
    void readFile;
  });
});
