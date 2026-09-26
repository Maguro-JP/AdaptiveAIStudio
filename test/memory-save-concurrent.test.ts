/**
 * 記憶の保存が重なっても壊れない。
 *
 * 画面で二つの会話を同時に動かすと、どちらも依頼の終わりに `Memory.save()` を呼ぶ。
 * 同じファイルへ同時に書くと中身が混ざり得る。書いている最中に覚えた分が「保存済み」扱いで
 * 消されると、その分は二度と保存されない。どちらも利用者の記憶を失う形なので、会話を分ける前に塞ぐ。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Memory } from '../src/memory/memory.ts';

async function place(): Promise<string> {
  return join(await tempDir('aas-memory-save-'), 'memory.jsonl');
}

/** 書く手を作り物にして、同時に書いている数の最大と、書いた中身を記録する。`hold` が開くまで書き終えない。 */
function recordingWriter() {
  let now = 0;
  let max = 0;
  const bodies: string[] = [];
  let open!: () => void;
  const hold = new Promise<void>((r) => { open = r; });
  const write = async (_path: string, body: string) => {
    now += 1;
    max = Math.max(max, now);
    await hold;
    bodies.push(body);
    now -= 1;
  };
  return { write, open, bodies, max: () => max };
}

describe('記憶の保存が重なる', () => {
  test('同時に何度保存を呼んでも、書くのは一つずつ', async () => {
    const path = await place();
    const w = recordingWriter();
    const memory = new Memory(path, { write: w.write });
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 10; i += 1) {
      memory.remember({ kind: 'fact', title: `事実 ${i}` });
      saves.push(memory.save());
    }
    // 最初の書き込みが止まっている間に、次が書き始めていないこと。
    await new Promise((r) => setTimeout(r, 20));
    w.open();
    await Promise.all(saves);
    assert.equal(w.max(), 1, `同時に ${w.max()} 本書いている`);
  });

  test('書いている最中に覚えた分も、次の保存で必ず書かれる（保存済み扱いで消さない）', async () => {
    const path = await place();
    const w = recordingWriter();
    const memory = new Memory(path, { write: w.write });
    memory.remember({ kind: 'fact', title: '先' });
    const first = memory.save();
    await new Promise((r) => setTimeout(r, 20));   // 最初の保存が書く手の中で止まっている
    memory.remember({ kind: 'fact', title: '後' });
    const second = memory.save();
    w.open();
    await Promise.all([first, second]);
    const last = w.bodies.at(-1) ?? '';
    const titles = last.split('\n').filter((l) => l.trim()).map((l) => (JSON.parse(l) as { title: string }).title);
    assert.deepEqual(titles.sort(), ['先', '後'], `後で覚えた分が書かれていない: ${w.bodies.length} 回書いた`);
  });

  test('書くのに失敗したら、次の保存でもう一度書く（失敗で列を止めない）', async () => {
    const path = await place();
    let fail = true;
    const bodies: string[] = [];
    const memory = new Memory(path, {
      write: async (_p, body) => { if (fail) throw new Error('disk'); bodies.push(body); },
    });
    memory.remember({ kind: 'fact', title: '一' });
    await assert.rejects(memory.save());
    fail = false;
    await memory.save();
    assert.equal(bodies.length, 1, '失敗の後に書き直していない');
  });

  test('本物のファイルでも、同時に保存して全部の行が読める', async () => {
    const path = await place();
    const memory = new Memory(path);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 40; i += 1) {
      memory.remember({ kind: 'fact', title: `事実 ${i}`, detail: 'x'.repeat(2000) });
      saves.push(memory.save());
    }
    await Promise.all(saves);
    const again = new Memory(path);
    await again.load();
    assert.equal(again.size, 40);
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 40);
  });
});
