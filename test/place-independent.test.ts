/**
 * 走らせる場所で結果が変わるテストを、書かない。
 *
 * 前に「portable の中で走らせたときだけ落ちる」を作った。今日また作った——
 * `readFile('src/runtime/model-install.ts')` のように、いま居る場所からの
 * 相対でリポジトリの中を読んでいた。**別の場所から走らせると、そんなものは
 * 無いと言って落ちる。**中身は何も壊れていないのに。
 *
 * 決まりを文章で書いても守れなかったので、書き方で止める。
 * 読むときは、このファイルの位置から `join(root, ...)` で作る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** リポジトリの中を指していそうな、いま居る場所からの相対。 */
const REPO_DIRS = ['src', 'scripts', 'test', 'docs', 'installer', 'web'];

test('リポジトリの中を、いま居る場所からの相対で読まない', () => {
  const bad: string[] = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(here, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      // 注釈は見ない（この文書の中に、悪い例そのものを書いてある）。
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
      const re = new RegExp(
        `(readFile|readFileSync|readdir|readdirSync|stat|statSync|access|open)`
        + `\\(\\s*['"\`](${REPO_DIRS.join('|')})(/|['"\`])`,
      );
      if (re.test(line)) bad.push(`test/${name}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [],
    '走らせる場所で結果が変わります。`join(root, ...)` で作ってください:\n  ' + bad.join('\n  '));
});

/*
 * **これだけでは足りない。**上は「読む呼び出しに直に書いた道」しか見ない。
 * 今日の二つ目は `sources('src')` という自作の関数越しだったので、ここには
 * 掛からない。そこで、ファイルを読むテストは**必ず自分の位置を持つ**ことも
 * 見る。持っていれば `join(root, ...)` を書く下地がある。
 */
test('ファイルを読むテストは、自分の位置を持つ', () => {
  const bad: string[] = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(here, name), 'utf8');
    const readsRepo = REPO_DIRS.some((d) => new RegExp(`['"\`]${d}(/|['"\`])`).test(text))
      && /\b(readFile|readFileSync|readdir|readdirSync)\s*\(/.test(text);
    if (!readsRepo) continue;
    /*
     * 自分の位置（`import.meta.url` / `import.meta.dirname`）か、根を返すもの
     * （`installRoot`）を持っているか。
     *
     * **`import.meta.dirname` を見ていなかった。**`dirname(fileURLToPath(
     * import.meta.url))` と同じものを Node が直に持っているだけなので、
     * 位置は持っている。見ていなかったので、そちらで書いた試験が
     * 「位置を持っていない」として落ちた（網の側が古い）。
     */
    if (/import\.meta\.(url|dirname)|installRoot|tempDir/.test(text)) continue;
    bad.push(`test/${name}`);
  }
  assert.deepEqual(bad, [],
    'ファイルを読むのに、自分の位置を持っていません:\n  ' + bad.join('\n  '));
});
