/**
 * 答えを、読める形で出す。
 *
 * 答えはそのまま textContent に流していた。モデルが書く ``` の囲いも
 * 記号のまま並び、**書いたコードがコードとして読めなかった。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline } from '../src/ui/web/markdown.js';
import { Worker } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * 別の thread で切らせ、時間内に返らなければ止める。返らない（進まない）形のとき、同じ thread で呼ぶと試験ごと固まる。
 */
function parseWithin(text: string, ms = 3000): Promise<unknown> {
  const url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/markdown.js')).href;
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     import(workerData.url).then((m) => parentPort.postMessage(m.parseBlocks(workerData.text)));`,
    { eval: true, workerData: { url, text } },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`返らない: ${JSON.stringify(text)}`)); }, ms);
    worker.once('message', (v) => { clearTimeout(timer); void worker.terminate(); resolve(v); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('答えを塊に切る', () => {
  test('囲いは、コードの塊になる', () => {
    const b = parseBlocks('説明\n```js\nconsole.log(1)\n```\n補足');
    assert.deepEqual(b, [
      { type: 'para', text: '説明' },
      { type: 'code', lang: 'js', text: 'console.log(1)', closed: true },
      { type: 'para', text: '補足' },
    ]);
  });

  test('**閉じていない囲いも、そこまでをコードにする**（流れている途中）', () => {
    const b = parseBlocks('```\nconst a = 1');
    assert.deepEqual(b, [{ type: 'code', lang: '', text: 'const a = 1', closed: false }]);
  });

  test('囲いの中は、見出しや箇条書きに見えても触らない', () => {
    const b = parseBlocks('```\n# not heading\n- not item\n```');
    assert.equal(b.length, 1);
    assert.equal(b[0]!.type, 'code');
    assert.equal((b[0] as { text: string }).text, '# not heading\n- not item');
  });

  test('見出しと箇条書き', () => {
    const b = parseBlocks('## 手順\n1. 読む\n2. 直す\n- 補足');
    assert.deepEqual(b, [
      { type: 'heading', level: 2, text: '手順' },
      { type: 'list', ordered: true, items: ['読む', '直す'], start: 1 },
      { type: 'list', ordered: false, items: ['補足'], start: 1 },
    ]);
  });

  test('空でも落ちない', () => {
    assert.deepEqual(parseBlocks(''), []);
    assert.deepEqual(parseBlocks(undefined as unknown as string), []);
  });

  test('行の中の code と bold', () => {
    assert.deepEqual(parseInline('a `b` **c** d'), [
      { type: 'text', text: 'a ' }, { type: 'code', text: 'b' }, { type: 'text', text: ' ' },
      { type: 'bold', text: 'c' }, { type: 'text', text: ' d' },
    ]);
  });

  test('HTML に見える文字は、文字のまま（塊の中身は文字列で持つ）', () => {
    // 木を組むときは textContent で入れる。ここで <b> が消えていないことを見る。
    const b = parseBlocks('<b>x</b>');
    assert.deepEqual(b, [{ type: 'para', text: '<b>x</b>' }]);
  });
});

describe('画面が、答えを組み直して出す', () => {
  test('panels.js は、答えに textContent を直に足していない', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/panels.js'), 'utf8');
    assert.ok(src.includes('renderMarkdown('), '答えを組み直していない');
    assert.ok(!/stream\.textContent \+=/.test(src), '答えを素の文のまま足している');
    // innerHTML に外から来た文を流していないこと。
    assert.ok(!/innerHTML\s*=/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/markdown.js'), 'utf8')));
  });
});

describe('どんな行でも、読み進める（固まらない）', () => {
  test('言語名の後ろに何か書いた囲い・CRLF の見出しと箇条書き・一行の囲いでも返る', async () => {
    for (const text of ['```python main.py\nx\n```', '``` js\nx\n```', '# a\r\nb', '- a\r\n- b\r\n', '```a```b', '1. x\r\n2. y']) {
      const blocks = await parseWithin(text) as { type: string }[];
      assert.ok(Array.isArray(blocks) && blocks.length > 0, JSON.stringify(text));
    }
  });

  test('一行に閉じた囲いは一行の段落、4 つ以上の ` の囲いはコード', () => {
    assert.deepEqual(parseBlocks('```a```b'), [{ type: 'para', text: '```a```b' }]);
    assert.deepEqual(parseBlocks('````md\n```js\n````'), [{ type: 'code', lang: 'md', text: '```js', closed: true }]);
  });

  test('CRLF でも、見出しは見出し、囲いの言語名は言語名になる', () => {
    assert.deepEqual(parseBlocks('# 題\r\n本文'), [{ type: 'heading', level: 1, text: '題' }, { type: 'para', text: '本文' }]);
    assert.deepEqual(parseBlocks('```python main.py\nx\n```'), [{ type: 'code', lang: 'python', text: 'x', closed: true }]);
  });
});

describe('囲いと番号（55 回目の調査）', () => {
  test('**4 つの ` で開いた囲いは、中の ``` では閉じない**', () => {
    const got = parseBlocks('````md\n```js\nx\n```\n````\nafter') as { type: string; text?: string }[];
    assert.equal(got[0]?.type, 'code');
    assert.equal(got[0]?.text, '```js\nx\n```', '中の ``` で閉じた');
    assert.equal(got[1]?.type, 'para');
  });

  test('**番号付きの箇条書きは、最初の項目の数から始める**', () => {
    const got = parseBlocks('3. a\n4. b') as { type: string; start?: number }[];
    assert.equal(got[0]?.start, 3, '続きの番号が 1 から振り直された');
  });
});
