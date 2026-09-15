/**
 * 道の隣の「開く」「コピー」。
 *
 * 道は画面に出ていたが、開いて確かめる手が無かった。本物のブラウザは使わず、
 * 開く先とコピーの手を差し込んで、押した結果を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { pathActions } = await import('../src/ui/web/paths.js') as unknown as {
  pathActions: (path: string, deps?: Record<string, unknown>) => StubNode;
};

describe('道の隣の押し場所', () => {
  test('開くは、その道を本体へ渡す', async () => {
    const opened: string[] = [];
    const box = pathActions('/w/a.txt', { open: async (p: string) => { opened.push(p); return { ok: true, body: {} }; } });
    const open = box.buttons().find((b) => b.textContent === '開く')!;
    assert.ok(open.title.includes('/w/a.txt'));
    await open.onclick!();
    assert.deepEqual(opened, ['/w/a.txt']);
  });

  test('開けなかったら、理由をそのまま言う', async () => {
    const said: string[] = [];
    const box = pathActions('/w/a.txt', {
      open: async () => ({ ok: false, body: { error: '開けるのは、このプログラムが使っている場所の中だけです' } }),
      say: (m: string) => { said.push(m); },
    });
    await box.buttons().find((b) => b.textContent === '開く')!.onclick!();
    assert.deepEqual(said, ['開けるのは、このプログラムが使っている場所の中だけです']);
  });

  test('コピーは、道をそのまま渡し、押した場所で結果を言う', async () => {
    const copied: string[] = [];
    const box = pathActions('C:\\work\\a.txt', { copy: async (t: string) => { copied.push(t); } });
    const copy = box.buttons().find((b) => b.textContent === 'コピー')!;
    await copy.onclick!();
    assert.deepEqual(copied, ['C:\\work\\a.txt']);
    assert.equal(copy.textContent, 'コピーした');
    await until(() => copy.textContent === 'コピー', '文言が戻る', { timeoutMs: 5000 });
  });

  test('コピーできない機械では、できないと言う（黙って何も起きない、にしない）', async () => {
    const box = pathActions('/w/a.txt', { copy: async () => { throw new Error('許されていない'); } });
    const copy = box.buttons().find((b) => b.textContent === 'コピー')!;
    await copy.onclick!();
    assert.equal(copy.textContent, 'コピーできない');
  });

  test('道が無ければ、何も置かない（対）', () => {
    assert.equal(pathActions('').buttons().length, 0);
  });
});
